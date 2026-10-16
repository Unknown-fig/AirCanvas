import {
  FilesetResolver,
  HandLandmarker,
  HandLandmarkerResult,
} from '@mediapipe/tasks-vision';

export const MEDIAPIPE_VISION_VERSION = '0.10.14';
export const WASM_PATH = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VISION_VERSION}/wasm`;
export const MODEL_ASSET_PATH =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export async function createHandTracker(): Promise<HandLandmarker> {
  const vision = await FilesetResolver.forVisionTasks(WASM_PATH);

  try {
    // Attempt initialization with GPU delegate first
    return await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_ASSET_PATH,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 1,
    });
  } catch (gpuError) {
    console.warn('MediaPipe GPU delegate failed, falling back to CPU:', gpuError);
    // Fall back to CPU delegate
    return await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_ASSET_PATH,
        delegate: 'CPU',
      },
      runningMode: 'VIDEO',
      numHands: 1,
    });
  }
}

export function detectHand(
  landmarker: HandLandmarker,
  video: HTMLVideoElement,
  timestampMs: number
): HandLandmarkerResult | null {
  // Guard on loadedmetadata/videoWidth > 0 and video element state
  if (
    video.readyState < 2 ||
    video.videoWidth === 0 ||
    video.videoHeight === 0 ||
    video.paused ||
    video.ended
  ) {
    return null;
  }

  return landmarker.detectForVideo(video, timestampMs);
}
