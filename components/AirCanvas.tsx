'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import type { HandLandmarker } from '@mediapipe/tasks-vision';
import { Stroke, ViewMode, GestureDisplay } from '@/lib/types';
import { EMAFilter } from '@/lib/smoothing';
import { GestureClassifier } from '@/lib/gestures';
import { createHandTracker, detectHand } from '@/lib/handTracker';
import { DepthEstimator, unprojectScreenToWorld } from '@/lib/depth';
import { SculptScene } from '@/lib/scene3d';
import { FlickTracker } from '@/lib/flick';

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
    renderedWidth = containerWidth;
    renderedHeight = containerWidth / videoAspect;
    offsetX = 0;
    offsetY = (containerHeight - renderedHeight) / 2;
  } else {
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

function renderStroke2D(ctx: CanvasRenderingContext2D, stroke: Stroke) {
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

// Module-level pre-allocated scratch vectors to prevent hot-path allocations
const scratchWorldP8 = new THREE.Vector3();
const scratchWorldP9 = new THREE.Vector3();

export default function AirCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvas2dRef = useRef<HTMLCanvasElement | null>(null);
  const canvasThreeRef = useRef<HTMLCanvasElement | null>(null);

  // 3D Scene Subsystem
  const scene3dRef = useRef<SculptScene | null>(null);
  const depthEstimatorRef = useRef<DepthEstimator>(new DepthEstimator(0.15));
  const flickTrackerRef = useRef<FlickTracker>(new FlickTracker());

  // 2D Drawing refs (decoupled from React render lifecycle)
  const completedStrokes2DRef = useRef<Stroke[]>([]);
  const currentStroke2DRef = useRef<Stroke | null>(null);

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

  // Mode and Visual Configuration
  const [viewMode, setViewMode] = useState<ViewMode>('sculptor');
  const [color, setColor] = useState<string>('#00F5FF');
  const [strokeWidth, setStrokeWidth] = useState<number>(6); // 2D stroke width (px)
  const [ribbonRadius, setRibbonRadius] = useState<number>(0.03); // 3D ribbon radius (world units)
  const [alpha, setAlpha] = useState<number>(0.35);
  const [bloomEnabled, setBloomEnabled] = useState<boolean>(true);
  const [strokeCount, setStrokeCount] = useState<number>(0);

  // Diagnostic telemetry
  const [gestureBadge, setGestureBadge] = useState<GestureDisplay>('No hand');
  const [fps, setFps] = useState<number>(0);
  const [latency, setLatency] = useState<number>(0);
  const [debugScale, setDebugScale] = useState<number>(0);
  const [debugZ, setDebugZ] = useState<number>(0);

  // Refs mirroring state for synchronous access within the rAF loop
  const viewModeRef = useRef<ViewMode>(viewMode);
  const currentColorRef = useRef<string>(color);
  const currentWidthRef = useRef<number>(strokeWidth);
  const currentRadiusRef = useRef<number>(ribbonRadius);
  const currentAlphaRef = useRef<number>(alpha);
  const bloomEnabledRef = useRef<boolean>(bloomEnabled);

  useEffect(() => {
    viewModeRef.current = viewMode;
    if (scene3dRef.current) {
      setStrokeCount(
        viewMode === 'sculptor'
          ? scene3dRef.current.ribbons.getCompletedStrokeCount()
          : completedStrokes2DRef.current.length
      );
    }
  }, [viewMode]);

  useEffect(() => {
    currentColorRef.current = color;
  }, [color]);

  useEffect(() => {
    currentWidthRef.current = strokeWidth;
  }, [strokeWidth]);

  useEffect(() => {
    currentRadiusRef.current = ribbonRadius;
  }, [ribbonRadius]);

  useEffect(() => {
    bloomEnabledRef.current = bloomEnabled;
  }, [bloomEnabled]);

  useEffect(() => {
    currentAlphaRef.current = alpha;
    filter8Ref.current.setAlpha(alpha);
    filter12Ref.current.setAlpha(alpha);
  }, [alpha]);

  // Synchronize 2D Canvas DPR and Three.js viewport
  const updateViewportSizes = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.round(rect.width);
    const cssHeight = Math.round(rect.height);

    // 1. Update 2D Canvas
    const canvas2d = canvas2dRef.current;
    if (canvas2d) {
      canvas2d.width = Math.round(cssWidth * dpr);
      canvas2d.height = Math.round(cssHeight * dpr);
      canvas2d.style.width = `${cssWidth}px`;
      canvas2d.style.height = `${cssHeight}px`;

      const ctx = canvas2d.getContext('2d');
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }

    // 2. Update Three.js Canvas & Composer
    if (scene3dRef.current && cssWidth > 0 && cssHeight > 0) {
      scene3dRef.current.setSize(cssWidth, cssHeight);
    }
  }, []);

  // Clear both 2D and 3D strokes
  const handleClear = useCallback(() => {
    // Clear 2D
    completedStrokes2DRef.current = [];
    currentStroke2DRef.current = null;
    filter8Ref.current.reset();
    filter12Ref.current.reset();

    // Clear 3D
    if (scene3dRef.current) {
      scene3dRef.current.clear();
    }
    depthEstimatorRef.current.reset();
    flickTrackerRef.current.reset();

    setStrokeCount(0);
  }, []);

  // End active 2D stroke and apply 3-frame tail-trim
  const finalizeCurrentStroke2D = useCallback(() => {
    if (!currentStroke2DRef.current) return;

    const pts = currentStroke2DRef.current.points;
    const trimmedPoints = pts.slice(0, Math.max(0, pts.length - 3));

    if (trimmedPoints.length >= 2) {
      completedStrokes2DRef.current.push({
        ...currentStroke2DRef.current,
        points: trimmedPoints,
      });
      if (viewModeRef.current === 'flat') {
        setStrokeCount(completedStrokes2DRef.current.length);
      }
    }

    currentStroke2DRef.current = null;
    filter8Ref.current.reset();
  }, []);

  // Reset 3D Orbit View
  const handleResetView = useCallback(() => {
    if (scene3dRef.current) {
      scene3dRef.current.resetView();
    }
  }, []);

  // Unified rAF rendering loop (drives 2D overlay and Three.js simultaneously)
  useEffect(() => {
    if (!isReady) return;

    let isSubscribed = true;
    let frameCounter = 0;
    let lastTelemetryTime = performance.now();
    let accumulatedLatency = 0;
    let latencySampleCount = 0;
    let prevConfirmedGesture: string = 'HOVER';
    let lastLoopTime = performance.now();

    const loop = () => {
      if (!isSubscribed) return;

      const now = performance.now();
      const dt = Math.min((now - lastLoopTime) / 1000, 0.05); // clamp dt to 0.05s
      lastLoopTime = now;

      const video = videoRef.current;
      const canvas2d = canvas2dRef.current;
      const container = containerRef.current;
      const landmarker = landmarkerRef.current;
      const scene3d = scene3dRef.current;
      const currentMode = viewModeRef.current;

      if (video && canvas2d && container && landmarker) {
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;
        const ctx2d = canvas2d.getContext('2d');

        if (ctx2d && containerWidth > 0 && containerHeight > 0) {
          // 1. MediaPipe Inference (skipped if frame has not advanced)
          let landmarksResult = null;
          if (
            video.currentTime !== lastVideoTimeRef.current &&
            video.readyState >= 2 &&
            video.videoWidth > 0
          ) {
            lastVideoTimeRef.current = video.currentTime;

            const t0 = performance.now();
            landmarksResult = detectHand(landmarker, video, now);
            const dtInference = performance.now() - t0;

            accumulatedLatency += dtInference;
            latencySampleCount++;
          }

          const primaryHand = landmarksResult?.landmarks?.[0];
          const gestureResult = gestureClassifierRef.current.update(primaryHand, now);

          // In 3D Sculptor Mode, fist-hold-to-clear is disabled in favor of Orbiting
          if (currentMode === 'flat' && gestureResult.shouldClear) {
            handleClear();
          }

          // Handle state transitions out of DRAW
          if (prevConfirmedGesture === 'DRAW' && gestureResult.confirmedGesture !== 'DRAW') {
            if (currentMode === 'flat') {
              finalizeCurrentStroke2D();
            } else if (scene3d) {
              const finalized = scene3d.ribbons.finalizeStroke();
              if (finalized) {
                scene3d.updateOrbitPivot();
                setStrokeCount(scene3d.ribbons.getCompletedStrokeCount());
              }
            }
          }
          prevConfirmedGesture = gestureResult.confirmedGesture;

          // 2. Landmark Processing
          let p8Smoothed: { x: number; y: number } | null = null;
          let p12Smoothed: { x: number; y: number } | null = null;
          let p9Center: { x: number; y: number } | null = null;
          let p0Wrist: { x: number; y: number } | null = null;
          let worldZ = 0;
          let handScale = 0;

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

            // Landmark #9: middle MCP (center of hand / fist)
            p9Center = mapNormalizedToScreen(
              primaryHand[9].x,
              primaryHand[9].y,
              video.videoWidth,
              video.videoHeight,
              containerWidth,
              containerHeight
            );

            // Landmark #0: wrist
            p0Wrist = mapNormalizedToScreen(
              primaryHand[0].x,
              primaryHand[0].y,
              video.videoWidth,
              video.videoHeight,
              containerWidth,
              containerHeight
            );

            // Depth calculation in 3D Sculptor Mode
            if (currentMode === 'sculptor' && scene3d) {
              handScale = depthEstimatorRef.current.computeHandScale(
                primaryHand[0],
                primaryHand[9],
                video.videoWidth,
                video.videoHeight
              );
              worldZ = depthEstimatorRef.current.computeWorldZ(handScale);

              // Unproject smoothed index fingertip (#8)
              unprojectScreenToWorld(
                p8Smoothed.x,
                p8Smoothed.y,
                containerWidth,
                containerHeight,
                worldZ,
                scene3d.camera,
                scratchWorldP8
              );

              // Unproject middle MCP (#9) using identical unproject pipeline (Amendment #1)
              unprojectScreenToWorld(
                p9Center.x,
                p9Center.y,
                containerWidth,
                containerHeight,
                worldZ,
                scene3d.camera,
                scratchWorldP9
              );
            }
          } else {
            filter8Ref.current.reset();
            filter12Ref.current.reset();
            if (currentMode === 'flat') {
              if (currentStroke2DRef.current) finalizeCurrentStroke2D();
            } else if (scene3d) {
              const finalized = scene3d.ribbons.finalizeStroke();
              if (finalized) {
                scene3d.updateOrbitPivot();
                setStrokeCount(scene3d.ribbons.getCompletedStrokeCount());
              }
            }
          }

          // 3. 3D Engine Updates (Sculptor Mode only)
          const isFist = gestureResult.confirmedGesture === 'FIST';

          if (currentMode === 'sculptor' && scene3d) {
            // Update Orbiting when in FIST
            scene3d.updateOrbit(
              isFist,
              p9Center ? p9Center.x : null,
              p9Center ? p9Center.y : null,
              containerWidth,
              dt
            );

            // Drawing and particle emission pause while in FIST
            if (!isFist && p8Smoothed && primaryHand) {
              if (gestureResult.confirmedGesture === 'DRAW') {
                // Add point to active 3D ribbon
                scene3d.ribbons.addPoint(
                  scratchWorldP8,
                  currentColorRef.current,
                  currentRadiusRef.current,
                  now
                );
                scene3d.ribbons.updateActiveMesh(now);

                // Emit continuous particle trail at fingertip
                scene3d.particles.emitTrail(scratchWorldP8, currentColorRef.current, dt);
              } else if (gestureResult.displayGesture === 'Hovering') {
                // Hover trail
                scene3d.particles.emitTrail(scratchWorldP8, currentColorRef.current, dt);
              }

              // Wrist Flick Burst Check (Amendment #1: burst origin at unprojected landmark #9)
              if (p0Wrist) {
                const burstTriggered = flickTrackerRef.current.update(
                  p0Wrist.x,
                  p0Wrist.y,
                  containerWidth,
                  gestureResult.confirmedGesture,
                  now
                );
                if (burstTriggered) {
                  scene3d.particles.emitBurst(scratchWorldP9, currentColorRef.current, 150);
                }
              }
            }

            // Render Three.js Scene
            scene3d.render(dt, bloomEnabledRef.current);
          }

          // 4. 2D Engine Updates (Flat Mode only)
          if (currentMode === 'flat') {
            if (gestureResult.confirmedGesture === 'DRAW' && p8Smoothed) {
              if (!currentStroke2DRef.current) {
                currentStroke2DRef.current = {
                  points: [{ x: p8Smoothed.x, y: p8Smoothed.y, time: now }],
                  color: currentColorRef.current,
                  width: currentWidthRef.current,
                };
              } else {
                const pts = currentStroke2DRef.current.points;
                const lastPt = pts[pts.length - 1];
                const dx = p8Smoothed.x - lastPt.x;
                const dy = p8Smoothed.y - lastPt.y;

                if (dx * dx + dy * dy >= 4) {
                  pts.push({ x: p8Smoothed.x, y: p8Smoothed.y, time: now });
                }
              }
            }
          }

          // 5. Redraw 2D Canvas Overlays
          ctx2d.clearRect(0, 0, containerWidth, containerHeight);

          // Render 2D strokes only in Flat Mode
          if (currentMode === 'flat') {
            for (let i = 0; i < completedStrokes2DRef.current.length; i++) {
              renderStroke2D(ctx2d, completedStrokes2DRef.current[i]);
            }
            if (currentStroke2DRef.current) {
              renderStroke2D(ctx2d, currentStroke2DRef.current);
            }
          }

          // Visual Reticle Overlays (applied in both modes)
          const displayLabel: GestureDisplay =
            currentMode === 'sculptor' && isFist
              ? 'Orbiting'
              : gestureResult.displayGesture;

          if (displayLabel === 'Hovering' && p8Smoothed) {
            // Glowing circular reticle at index fingertip
            ctx2d.beginPath();
            ctx2d.arc(p8Smoothed.x, p8Smoothed.y, 16, 0, Math.PI * 2);
            ctx2d.fillStyle = 'rgba(0, 245, 255, 0.15)';
            ctx2d.fill();

            ctx2d.beginPath();
            ctx2d.arc(p8Smoothed.x, p8Smoothed.y, 8, 0, Math.PI * 2);
            ctx2d.strokeStyle = '#00F5FF';
            ctx2d.lineWidth = 2;
            ctx2d.stroke();

            ctx2d.beginPath();
            ctx2d.arc(p8Smoothed.x, p8Smoothed.y, 2.5, 0, Math.PI * 2);
            ctx2d.fillStyle = '#FFFFFF';
            ctx2d.fill();
          } else if (displayLabel === 'Selecting' && p8Smoothed && p12Smoothed) {
            // Subtle rings around fingertips #8 and #12
            ctx2d.beginPath();
            ctx2d.arc(p8Smoothed.x, p8Smoothed.y, 12, 0, Math.PI * 2);
            ctx2d.strokeStyle = '#FF00E5';
            ctx2d.lineWidth = 2;
            ctx2d.stroke();

            ctx2d.beginPath();
            ctx2d.arc(p12Smoothed.x, p12Smoothed.y, 12, 0, Math.PI * 2);
            ctx2d.strokeStyle = '#FF00E5';
            ctx2d.lineWidth = 2;
            ctx2d.stroke();
          } else if (displayLabel === 'Clearing' && p9Center && currentMode === 'flat') {
            // Radial progress ring (2D mode only)
            const progress = gestureResult.fistProgress;
            const radius = 34;

            ctx2d.beginPath();
            ctx2d.arc(p9Center.x, p9Center.y, radius, 0, Math.PI * 2);
            ctx2d.strokeStyle = 'rgba(255, 255, 255, 0.25)';
            ctx2d.lineWidth = 5;
            ctx2d.stroke();

            ctx2d.beginPath();
            ctx2d.arc(
              p9Center.x,
              p9Center.y,
              radius,
              -Math.PI / 2,
              -Math.PI / 2 + Math.PI * 2 * progress
            );
            ctx2d.strokeStyle = '#FF334B';
            ctx2d.lineWidth = 5;
            ctx2d.lineCap = 'round';
            ctx2d.stroke();

            ctx2d.beginPath();
            ctx2d.arc(p9Center.x, p9Center.y, radius - 4, 0, Math.PI * 2);
            ctx2d.fillStyle = `rgba(255, 51, 75, ${0.1 + progress * 0.3})`;
            ctx2d.fill();

            ctx2d.font = '600 11px sans-serif';
            ctx2d.fillStyle = '#FFFFFF';
            ctx2d.textAlign = 'center';
            ctx2d.textBaseline = 'middle';
            ctx2d.fillText(`${Math.round(progress * 100)}%`, p9Center.x, p9Center.y);
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
            setGestureBadge(displayLabel);
            setDebugScale(Number(handScale.toFixed(3)));
            setDebugZ(Number(worldZ.toFixed(2)));

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
  }, [isReady, finalizeCurrentStroke2D, handleClear]);

  // Mount, unmount, and resize listeners
  useEffect(() => {
    let unmounted = false;
    const currentVideo = videoRef.current;
    const canvasThree = canvasThreeRef.current;
    const container = containerRef.current;

    async function initPipeline() {
      try {
        // Initialize MediaPipe HandLandmarker
        if (!landmarkerRef.current) {
          const tracker = await createHandTracker();
          if (unmounted) {
            tracker.close();
            return;
          }
          landmarkerRef.current = tracker;
        }

        if (unmounted) return;

        // Initialize Three.js Scene
        if (canvasThree && container && !scene3dRef.current) {
          const w = container.clientWidth || window.innerWidth;
          const h = container.clientHeight || window.innerHeight;
          scene3dRef.current = new SculptScene(canvasThree, w, h);
        }

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

        await new Promise<void>((resolve, reject) => {
          currentVideo.onloadedmetadata = async () => {
            try {
              await currentVideo.play();
              updateViewportSizes();
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
      if (!unmounted) updateViewportSizes();
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

      if (scene3dRef.current) {
        scene3dRef.current.dispose();
        scene3dRef.current = null;
      }
    };
  }, [retryTrigger, updateViewportSizes]);

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
      {/* Layer 1: Underlying Webcam Stream (Mirrored) */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className="absolute inset-0 w-full h-full object-cover -scale-x-100 pointer-events-none"
      />

      {/* Layer 2: Three.js WebGL Canvas with Screen Blend */}
      <canvas
        ref={canvasThreeRef}
        className={`absolute inset-0 w-full h-full pointer-events-none mix-blend-screen transition-opacity duration-300 ${
          viewMode === 'sculptor' ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {/* Layer 3: Transparent 2D Canvas Overlay */}
      <canvas
        ref={canvas2dRef}
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

      {/* Layer 4: Floating Frosted Glass HUD */}
      {isReady && (
        <header className="absolute top-4 left-4 z-20 flex flex-col gap-3 pointer-events-auto">
          <div className="backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl p-4 shadow-2xl text-white flex flex-col gap-3.5 min-w-[300px]">
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
                    : gestureBadge === 'Orbiting'
                    ? 'bg-amber-500/20 text-amber-300 border-amber-400/40 animate-pulse'
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

            {/* Mode Toggle: 2D Flat vs 3D Sculptor */}
            <div className="flex bg-black/40 p-1 rounded-xl border border-white/10 text-xs">
              <button
                onClick={() => setViewMode('flat')}
                className={`flex-1 py-1.5 rounded-lg font-medium transition ${
                  viewMode === 'flat'
                    ? 'bg-cyan-500/80 text-black font-semibold shadow'
                    : 'text-zinc-300 hover:text-white'
                }`}
              >
                2D Flat Mode
              </button>
              <button
                onClick={() => setViewMode('sculptor')}
                className={`flex-1 py-1.5 rounded-lg font-medium transition ${
                  viewMode === 'sculptor'
                    ? 'bg-cyan-500/80 text-black font-semibold shadow'
                    : 'text-zinc-300 hover:text-white'
                }`}
              >
                3D Sculptor Mode
              </button>
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

            {/* Mode-Specific Brush Controls */}
            {viewMode === 'flat' ? (
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
            ) : (
              <div className="flex flex-col gap-1">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
                    Ribbon Radius
                  </span>
                  <span className="text-zinc-300 font-mono text-[11px]">{ribbonRadius.toFixed(3)}</span>
                </div>
                <input
                  type="range"
                  min="0.01"
                  max="0.12"
                  step="0.005"
                  value={ribbonRadius}
                  onChange={(e) => setRibbonRadius(Number(e.target.value))}
                  className="w-full h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                />
              </div>
            )}

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

            {/* 3D Toggles: Bloom & Reset View */}
            {viewMode === 'sculptor' && (
              <div className="flex items-center justify-between pt-1 border-t border-white/10 text-xs">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={bloomEnabled}
                    onChange={(e) => setBloomEnabled(e.target.checked)}
                    className="rounded bg-white/20 border-white/30 text-cyan-400 focus:ring-0 cursor-pointer"
                  />
                  <span className="text-zinc-300 text-[11px]">Bloom Glow</span>
                </label>

                <button
                  onClick={handleResetView}
                  className="px-2.5 py-1 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-[11px] transition active:scale-95 text-zinc-200"
                >
                  Reset View
                </button>
              </div>
            )}

            {/* Depth Debug Telemetry (3D Mode) */}
            {viewMode === 'sculptor' && (
              <div className="text-[10px] font-mono text-zinc-400 bg-black/30 p-1.5 rounded-lg flex justify-between">
                <span>Scale: {debugScale.toFixed(3)}</span>
                <span>World Z: {debugZ.toFixed(2)}</span>
              </div>
            )}

            {/* Actions & Global Diagnostics */}
            <div className="pt-1 flex items-center justify-between border-t border-white/10 gap-2">
              <button
                onClick={handleClear}
                className="px-3 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl text-xs font-medium transition active:scale-95 text-zinc-200"
              >
                Clear ({strokeCount})
              </button>

              <div className="flex items-center gap-2 text-[11px] font-mono text-zinc-400">
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
