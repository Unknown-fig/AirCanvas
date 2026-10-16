'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { HandLandmarker } from '@mediapipe/tasks-vision';
import { Stroke, GestureDisplay } from '@/lib/types';
import { EMAFilter } from '@/lib/smoothing';
import { GestureClassifier } from '@/lib/gestures';
import { createHandTracker, detectHand } from '@/lib/handTracker';

const PALETTE = [
  { name: 'Cyan', hex: '#00F5FF' },
  { name: 'Magenta', hex: '#FF00E5' },
  { name: 'Lime', hex: '#7CFF00' },
  { name: 'White', hex: '#FFFFFF' },
];

function mapNormalizedToScreen(
  normX: number,
  normY: number,
  videoWidth: number,
  videoHeight: number,
  containerWidth: number,
  containerHeight: number
): { x: number; y: number } {
  const videoAspect = videoWidth / videoHeight;
  const containerAspect = containerWidth / containerHeight;
  let renderedWidth: number;
  let renderedHeight: number;
  let offsetX: number;
  let offsetY: number;

  if (containerAspect > videoAspect) {
    // Video is scaled to fit container width, vertical overflow is cropped evenly
    renderedWidth = containerWidth;
    renderedHeight = containerWidth / videoAspect;
    offsetX = 0;
    offsetY = (containerHeight - renderedHeight) / 2;
  } else {
    // Video is scaled to fit container height, horizontal overflow is cropped evenly
    renderedHeight = containerHeight;
    renderedWidth = containerHeight * videoAspect;
    offsetY = 0;
    offsetX = (containerWidth - renderedWidth) / 2;
  }

  // Mirror x before mapping to compensate for unmirrored canvas
  const mirroredX = 1 - normX;
  return {
    x: offsetX + mirroredX * renderedWidth,
    y: offsetY + normY * renderedHeight,
  };
}

function renderStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  const pts = stroke.points;
  if (pts.length === 0) return;

  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, stroke.width / 2, 0, Math.PI * 2);
    ctx.fillStyle = stroke.color;
    ctx.fill();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);

  // Smooth multi-point strokes via midpoint quadratic Bézier curves
  for (let i = 1; i < pts.length - 1; i++) {
    const midX = (pts[i].x + pts[i + 1].x) / 2;
    const midY = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
  }

  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  ctx.stroke();
}

export default function AirCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Runtime drawing refs (decoupled from React render lifecycle)
  const completedStrokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);

  // Dedicated EMA filters for landmarks #8 (index tip) and #12 (middle tip)
  const filter8Ref = useRef<EMAFilter>(new EMAFilter(0.35));
  const filter12Ref = useRef<EMAFilter>(new EMAFilter(0.35));
  const gestureClassifierRef = useRef<GestureClassifier>(new GestureClassifier());

  // MediaPipe tracking references
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const lastVideoTimeRef = useRef<number>(-1);
  const rafIdRef = useRef<number>(0);

  // React state for HUD and camera lifecycle
  const [loadingMessage, setLoadingMessage] = useState<string>('Initializing vision model...');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isReady, setIsReady] = useState<boolean>(false);
  const [retryTrigger, setRetryTrigger] = useState<number>(0);

  const [color, setColor] = useState<string>('#00F5FF');
  const [strokeWidth, setStrokeWidth] = useState<number>(6);
  const [alpha, setAlpha] = useState<number>(0.35);
  const [strokeCount, setStrokeCount] = useState<number>(0);

  // Diagnostic telemetry
  const [gestureBadge, setGestureBadge] = useState<GestureDisplay>('No hand');
  const [fps, setFps] = useState<number>(0);
  const [latency, setLatency] = useState<number>(0);

  // Refs mirroring state for synchronous access within the rAF loop
  const currentColorRef = useRef<string>(color);
  const currentWidthRef = useRef<number>(strokeWidth);
  const currentAlphaRef = useRef<number>(alpha);

  useEffect(() => {
    currentColorRef.current = color;
  }, [color]);

  useEffect(() => {
    currentWidthRef.current = strokeWidth;
  }, [strokeWidth]);

  useEffect(() => {
    currentAlphaRef.current = alpha;
    filter8Ref.current.setAlpha(alpha);
    filter12Ref.current.setAlpha(alpha);
  }, [alpha]);

  // Canvas size and DPR synchronization
  const updateCanvasSize = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.round(rect.width);
    const cssHeight = Math.round(rect.height);

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      // Re-apply setTransform on every resize to maintain DPR scaling
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }, []);

  // Clear both completed and in-progress strokes
  const handleClear = useCallback(() => {
    completedStrokesRef.current = [];
    currentStrokeRef.current = null;
    filter8Ref.current.reset();
    filter12Ref.current.reset();
    setStrokeCount(0);
  }, []);

  // End active DRAW stroke and drop the trailing 3 frames to avoid fold-artifacts
  const finalizeCurrentStroke = useCallback(() => {
    if (!currentStrokeRef.current) return;

    const pts = currentStrokeRef.current.points;
    const trimmedPoints = pts.slice(0, Math.max(0, pts.length - 3));

    if (trimmedPoints.length >= 2) {
      completedStrokesRef.current.push({
        ...currentStrokeRef.current,
        points: trimmedPoints,
      });
      setStrokeCount(completedStrokesRef.current.length);
    }

    currentStrokeRef.current = null;
    filter8Ref.current.reset();
  }, []);

  // Main rAF drawing and detection loop
  useEffect(() => {
    if (!isReady) return;

    let isSubscribed = true;
    let frameCounter = 0;
    let lastTelemetryTime = performance.now();
    let accumulatedLatency = 0;
    let latencySampleCount = 0;
    let prevConfirmedGesture: string = 'HOVER';

    const loop = () => {
      if (!isSubscribed) return;

      const now = performance.now();
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const container = containerRef.current;
      const landmarker = landmarkerRef.current;

      if (video && canvas && container && landmarker) {
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;
        const ctx = canvas.getContext('2d');

        if (ctx && containerWidth > 0 && containerHeight > 0) {
          // Skip frame detection if video playback has not advanced
          let landmarksResult = null;
          if (video.currentTime !== lastVideoTimeRef.current && video.readyState >= 2 && video.videoWidth > 0) {
            lastVideoTimeRef.current = video.currentTime;

            const t0 = performance.now();
            landmarksResult = detectHand(landmarker, video, now);
            const dt = performance.now() - t0;

            accumulatedLatency += dt;
            latencySampleCount++;
          }

          const primaryHand = landmarksResult?.landmarks?.[0];
          const gestureResult = gestureClassifierRef.current.update(primaryHand, now);

          // Handle FIST clear hold completion
          if (gestureResult.shouldClear) {
            handleClear();
          }

          // Handle state transitions out of DRAW
          if (prevConfirmedGesture === 'DRAW' && gestureResult.confirmedGesture !== 'DRAW') {
            finalizeCurrentStroke();
          }
          prevConfirmedGesture = gestureResult.confirmedGesture;

          // Process landmarks for drawing and visual reticles
          let p8Smoothed: { x: number; y: number } | null = null;
          let p12Smoothed: { x: number; y: number } | null = null;
          let p9Center: { x: number; y: number } | null = null;

          if (primaryHand && primaryHand.length >= 21) {
            const rawP8 = mapNormalizedToScreen(
              primaryHand[8].x,
              primaryHand[8].y,
              video.videoWidth,
              video.videoHeight,
              containerWidth,
              containerHeight
            );
            p8Smoothed = filter8Ref.current.filter(rawP8.x, rawP8.y);

            const rawP12 = mapNormalizedToScreen(
              primaryHand[12].x,
              primaryHand[12].y,
              video.videoWidth,
              video.videoHeight,
              containerWidth,
              containerHeight
            );
            p12Smoothed = filter12Ref.current.filter(rawP12.x, rawP12.y);

            // Landmark #9: middle MCP, used to anchor fist progress ring
            p9Center = mapNormalizedToScreen(
              primaryHand[9].x,
              primaryHand[9].y,
              video.videoWidth,
              video.videoHeight,
              containerWidth,
              containerHeight
            );
          } else {
            filter8Ref.current.reset();
            filter12Ref.current.reset();
            if (currentStrokeRef.current) {
              finalizeCurrentStroke();
            }
          }

          // Append points if currently DRAWing
          if (gestureResult.confirmedGesture === 'DRAW' && p8Smoothed) {
            if (!currentStrokeRef.current) {
              currentStrokeRef.current = {
                points: [{ x: p8Smoothed.x, y: p8Smoothed.y, time: now }],
                color: currentColorRef.current,
                width: currentWidthRef.current,
              };
            } else {
              const pts = currentStrokeRef.current.points;
              const lastPt = pts[pts.length - 1];
              const dx = p8Smoothed.x - lastPt.x;
              const dy = p8Smoothed.y - lastPt.y;

              // Append only if moved at least ~2px
              if (dx * dx + dy * dy >= 4) {
                pts.push({ x: p8Smoothed.x, y: p8Smoothed.y, time: now });
              }
            }
          }

          // Redraw Canvas Scene
          ctx.clearRect(0, 0, containerWidth, containerHeight);

          // 1. Render all committed strokes
          for (let i = 0; i < completedStrokesRef.current.length; i++) {
            renderStroke(ctx, completedStrokesRef.current[i]);
          }

          // 2. Render active stroke
          if (currentStrokeRef.current) {
            renderStroke(ctx, currentStrokeRef.current);
          }

          // 3. Render Reticle Overlays
          if (gestureResult.displayGesture === 'Hovering' && p8Smoothed) {
            // Glowing circular reticle at index fingertip
            ctx.beginPath();
            ctx.arc(p8Smoothed.x, p8Smoothed.y, 16, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(0, 245, 255, 0.15)';
            ctx.fill();

            ctx.beginPath();
            ctx.arc(p8Smoothed.x, p8Smoothed.y, 8, 0, Math.PI * 2);
            ctx.strokeStyle = '#00F5FF';
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(p8Smoothed.x, p8Smoothed.y, 2.5, 0, Math.PI * 2);
            ctx.fillStyle = '#FFFFFF';
            ctx.fill();
          } else if (gestureResult.displayGesture === 'Selecting' && p8Smoothed && p12Smoothed) {
            // Subtle rings around both fingertips (#8 and #12)
            ctx.beginPath();
            ctx.arc(p8Smoothed.x, p8Smoothed.y, 12, 0, Math.PI * 2);
            ctx.strokeStyle = '#FF00E5';
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(p12Smoothed.x, p12Smoothed.y, 12, 0, Math.PI * 2);
            ctx.strokeStyle = '#FF00E5';
            ctx.lineWidth = 2;
            ctx.stroke();
          } else if (gestureResult.displayGesture === 'Clearing' && p9Center) {
            // Radial progress ring anchored at landmark #9
            const progress = gestureResult.fistProgress;
            const radius = 34;

            // Background ring track
            ctx.beginPath();
            ctx.arc(p9Center.x, p9Center.y, radius, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
            ctx.lineWidth = 5;
            ctx.stroke();

            // Progress indicator arc
            ctx.beginPath();
            ctx.arc(
              p9Center.x,
              p9Center.y,
              radius,
              -Math.PI / 2,
              -Math.PI / 2 + Math.PI * 2 * progress
            );
            ctx.strokeStyle = '#FF334B';
            ctx.lineWidth = 5;
            ctx.lineCap = 'round';
            ctx.stroke();

            // Center glow and label
            ctx.beginPath();
            ctx.arc(p9Center.x, p9Center.y, radius - 4, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, 51, 75, ${0.1 + progress * 0.3})`;
            ctx.fill();

            ctx.font = '600 11px sans-serif';
            ctx.fillStyle = '#FFFFFF';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${Math.round(progress * 100)}%`, p9Center.x, p9Center.y);
          }

          // Telemetry and HUD state throttling (~4 Hz)
          frameCounter++;
          const elapsed = now - lastTelemetryTime;
          if (elapsed >= 250) {
            const calculatedFps = Math.round((frameCounter * 1000) / elapsed);
            const calculatedLatency =
              latencySampleCount > 0 ? Math.round(accumulatedLatency / latencySampleCount) : 0;

            setFps(calculatedFps);
            setLatency(calculatedLatency);
            setGestureBadge(gestureResult.displayGesture);

            frameCounter = 0;
            accumulatedLatency = 0;
            latencySampleCount = 0;
            lastTelemetryTime = now;
          }
        }
      }

      rafIdRef.current = requestAnimationFrame(loop);
    };

    rafIdRef.current = requestAnimationFrame(loop);

    return () => {
      isSubscribed = false;
      cancelAnimationFrame(rafIdRef.current);
    };
  }, [isReady, finalizeCurrentStroke, handleClear]);

  // Mount, unmount, and resize listeners for camera & vision pipeline
  useEffect(() => {
    let unmounted = false;
    const currentVideo = videoRef.current;

    async function initPipeline() {
      try {
        if (!landmarkerRef.current) {
          const tracker = await createHandTracker();
          if (unmounted) {
            tracker.close();
            return;
          }
          landmarkerRef.current = tracker;
        }

        if (unmounted) return;
        setLoadingMessage('Requesting camera access...');

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });

        if (unmounted || !currentVideo) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        currentVideo.srcObject = stream;

        // Guard on loadedmetadata/videoWidth > 0 and initiate playback
        await new Promise<void>((resolve, reject) => {
          currentVideo.onloadedmetadata = async () => {
            try {
              await currentVideo.play();
              updateCanvasSize();
              if (!unmounted) {
                setIsReady(true);
              }
              resolve();
            } catch (err) {
              reject(err);
            }
          };
          currentVideo.onerror = (err) => reject(err);
        });
      } catch (err: unknown) {
        if (unmounted) return;
        console.error('Initialization error:', err);
        let msg = 'Failed to initialize camera or vision model.';
        if (err instanceof DOMException) {
          if (err.name === 'NotAllowedError') {
            msg = 'Camera permission denied. Please allow camera access in your browser and click Retry.';
          } else if (err.name === 'NotFoundError') {
            msg = 'No camera found. Please connect a webcam and click Retry.';
          }
        } else if (err instanceof Error) {
          msg = err.message;
        }
        setErrorMessage(msg);
      }
    }

    initPipeline();

    const handleResize = () => {
      if (!unmounted) updateCanvasSize();
    };

    window.addEventListener('resize', handleResize);

    return () => {
      unmounted = true;
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(rafIdRef.current);

      if (currentVideo && currentVideo.srcObject) {
        const stream = currentVideo.srcObject as MediaStream;
        stream.getTracks().forEach((track) => track.stop());
        currentVideo.srcObject = null;
      }

      if (landmarkerRef.current) {
        landmarkerRef.current.close();
        landmarkerRef.current = null;
      }
    };
  }, [retryTrigger, updateCanvasSize]);

  const handleRetry = useCallback(() => {
    setErrorMessage(null);
    setIsReady(false);
    setLoadingMessage('Initializing vision model...');
    setRetryTrigger((prev) => prev + 1);
  }, []);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 w-screen h-screen overflow-hidden bg-black select-none"
    >
      {/* Underlying Webcam Stream (Mirrored) */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className="absolute inset-0 w-full h-full object-cover -scale-x-100 pointer-events-none"
      />

      {/* Transparent Canvas Overlay */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />

      {/* Loading Overlay */}
      {!isReady && !errorMessage && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/85 backdrop-blur-md z-30">
          <div className="w-12 h-12 border-4 border-cyan-400 border-t-transparent rounded-full animate-spin mb-4" />
          <p className="text-white text-lg font-medium tracking-wide">{loadingMessage}</p>
        </div>
      )}

      {/* Camera / Model Error Fallback */}
      {errorMessage && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 backdrop-blur-md z-30 p-6 text-center">
          <div className="p-4 rounded-full bg-rose-500/20 border border-rose-500/40 text-rose-400 mb-4 text-3xl">
            ⚠
          </div>
          <h2 className="text-white text-xl font-semibold mb-2">Camera Access Required</h2>
          <p className="text-zinc-300 max-w-md text-sm mb-6">{errorMessage}</p>
          <button
            onClick={handleRetry}
            className="px-6 py-2.5 bg-cyan-500 hover:bg-cyan-400 text-black font-semibold rounded-xl transition shadow-lg shadow-cyan-500/25 active:scale-95"
          >
            Retry Connection
          </button>
        </div>
      )}

      {/* Floating Frosted Glass HUD */}
      {isReady && (
        <header className="absolute top-4 left-4 z-20 flex flex-col gap-3 pointer-events-auto">
          <div className="backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl p-4 shadow-2xl text-white flex flex-col gap-3.5 min-w-[280px]">
            {/* Header & Gesture Badge */}
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse" />
                <h1 className="font-bold text-sm tracking-wide text-zinc-100">AIR CANVAS</h1>
              </div>

              {/* Status Badge */}
              <span
                className={`text-xs px-2.5 py-1 rounded-full font-semibold border transition-colors ${
                  gestureBadge === 'Drawing'
                    ? 'bg-lime-500/20 text-lime-300 border-lime-400/40 shadow-sm shadow-lime-500/20'
                    : gestureBadge === 'Selecting'
                    ? 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-400/40'
                    : gestureBadge === 'Clearing'
                    ? 'bg-rose-500/20 text-rose-300 border-rose-400/40 animate-pulse'
                    : gestureBadge === 'Hovering'
                    ? 'bg-cyan-500/20 text-cyan-300 border-cyan-400/40'
                    : 'bg-zinc-700/40 text-zinc-400 border-zinc-600/30'
                }`}
              >
                {gestureBadge}
              </span>
            </div>

            {/* Color Palette Selector */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
                Drawing Color
              </span>
              <div className="flex items-center gap-2">
                {PALETTE.map((item) => (
                  <button
                    key={item.hex}
                    onClick={() => setColor(item.hex)}
                    style={{ backgroundColor: item.hex }}
                    aria-label={`Select ${item.name}`}
                    className={`w-7 h-7 rounded-full border-2 transition-transform active:scale-90 ${
                      color === item.hex
                        ? 'border-white scale-110 shadow-md ring-2 ring-white/40'
                        : 'border-transparent opacity-75 hover:opacity-100'
                    }`}
                  />
                ))}
              </div>
            </div>

            {/* Stroke Width Slider */}
            <div className="flex flex-col gap-1">
              <div className="flex justify-between items-center text-xs">
                <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
                  Brush Width
                </span>
                <span className="text-zinc-300 font-mono text-[11px]">{strokeWidth}px</span>
              </div>
              <input
                type="range"
                min="2"
                max="16"
                step="1"
                value={strokeWidth}
                onChange={(e) => setStrokeWidth(Number(e.target.value))}
                className="w-full h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-cyan-400"
              />
            </div>

            {/* Smoothing Alpha Slider */}
            <div className="flex flex-col gap-1">
              <div className="flex justify-between items-center text-xs">
                <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
                  Smoothing (Alpha)
                </span>
                <span className="text-zinc-300 font-mono text-[11px]">{alpha.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min="0.10"
                max="0.90"
                step="0.05"
                value={alpha}
                onChange={(e) => setAlpha(Number(e.target.value))}
                className="w-full h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-cyan-400"
              />
            </div>

            {/* Actions & Diagnostics */}
            <div className="pt-1 flex items-center justify-between border-t border-white/10 gap-2">
              <button
                onClick={handleClear}
                className="px-3 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl text-xs font-medium transition active:scale-95 text-zinc-200"
              >
                Clear ({strokeCount})
              </button>

              <div className="flex items-center gap-2.5 text-[11px] font-mono text-zinc-400">
                <span>{fps} FPS</span>
                <span>•</span>
                <span>{latency} ms</span>
              </div>
            </div>
          </div>
        </header>
      )}
    </div>
  );
}
