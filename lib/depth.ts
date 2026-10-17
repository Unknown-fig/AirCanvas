import * as THREE from 'three';
import { NormalizedLandmark } from './types';

export const HAND_SCALE_NEAR = 0.28;
export const HAND_SCALE_FAR = 0.09;
export const Z_NEAR = 1.5;
export const Z_FAR = -3.5;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

export class DepthEstimator {
  private smoothedHandScale: number | null = null;
  private readonly alpha: number;

  constructor(alpha: number = 0.15) {
    this.alpha = alpha;
  }

  public reset(): void {
    this.smoothedHandScale = null;
  }

  public computeHandScale(
    lm0: NormalizedLandmark,
    lm9: NormalizedLandmark,
    videoWidth: number,
    videoHeight: number
  ): number {
    const dx = (lm0.x - lm9.x) * videoWidth;
    const dy = (lm0.y - lm9.y) * videoHeight;
    const rawScale = Math.hypot(dx, dy) / videoHeight;

    if (this.smoothedHandScale === null) {
      this.smoothedHandScale = rawScale;
    } else {
      this.smoothedHandScale =
        this.alpha * rawScale + (1 - this.alpha) * this.smoothedHandScale;
    }

    return this.smoothedHandScale;
  }

  public computeWorldZ(handScale: number): number {
    const clampedScale = clamp(
      handScale,
      Math.min(HAND_SCALE_FAR, HAND_SCALE_NEAR),
      Math.max(HAND_SCALE_FAR, HAND_SCALE_NEAR)
    );
    const t = clamp(
      (clampedScale - HAND_SCALE_FAR) / (HAND_SCALE_NEAR - HAND_SCALE_FAR),
      0,
      1
    );
    return lerp(Z_FAR, Z_NEAR, t);
  }
}

// Module-level pre-allocated vectors to prevent per-frame garbage collection
const scratchNdc = new THREE.Vector3();
const scratchRayOrigin = new THREE.Vector3();
const scratchRayDir = new THREE.Vector3();

/**
 * Unprojects a screen-pixel coordinate onto a world Z plane through the camera frustum.
 * Guarantees that the 3D world point projects directly beneath the screen cursor.
 */
export function unprojectScreenToWorld(
  screenX: number,
  screenY: number,
  containerWidth: number,
  containerHeight: number,
  worldZ: number,
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3
): THREE.Vector3 {
  // Convert screen coordinates to Normalized Device Coordinates (NDC)
  scratchNdc.set(
    (screenX / containerWidth) * 2 - 1,
    -(screenY / containerHeight) * 2 + 1,
    0.5
  );

  // Unproject NDC point into 3D world space
  scratchNdc.unproject(camera);

  scratchRayOrigin.copy(camera.position);
  scratchRayDir.subVectors(scratchNdc, scratchRayOrigin).normalize();

  // Find ray intersection with the plane Z = worldZ
  if (Math.abs(scratchRayDir.z) > 1e-6) {
    const s = (worldZ - scratchRayOrigin.z) / scratchRayDir.z;
    target.copy(scratchRayOrigin).addScaledVector(scratchRayDir, s);
  } else {
    target.copy(scratchRayOrigin);
    target.z = worldZ;
  }

  return target;
}
