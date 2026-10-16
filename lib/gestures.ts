import { Gesture, GestureDisplay, NormalizedLandmark } from './types';

export const EXTENSION_MARGIN = 1.05;
export const FIST_HOLD_DURATION_MS = 1500;
export const HYSTERESIS_FRAMES = 3;

function distance(a: NormalizedLandmark, b: NormalizedLandmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function isFingerExtended(
  landmarks: NormalizedLandmark[],
  tipIdx: number,
  pipIdx: number
): boolean {
  const wrist = landmarks[0];
  const tip = landmarks[tipIdx];
  const pip = landmarks[pipIdx];
  if (!wrist || !tip || !pip) return false;

  return distance(wrist, tip) > distance(wrist, pip) * EXTENSION_MARGIN;
}

export function classifyHand(landmarks: NormalizedLandmark[] | undefined | null): Gesture {
  if (!landmarks || landmarks.length < 21) {
    return 'HOVER';
  }

  const isIndexExtended = isFingerExtended(landmarks, 8, 6);
  const isMiddleExtended = isFingerExtended(landmarks, 12, 10);
  const isRingExtended = isFingerExtended(landmarks, 16, 14);
  const isPinkyExtended = isFingerExtended(landmarks, 20, 18);

  // DRAW: index up; middle, ring, pinky folded (ignore thumb)
  if (isIndexExtended && !isMiddleExtended && !isRingExtended && !isPinkyExtended) {
    return 'DRAW';
  }

  // SELECT: index + middle up; ring, pinky folded
  if (isIndexExtended && isMiddleExtended && !isRingExtended && !isPinkyExtended) {
    return 'SELECT';
  }

  // FIST: all four folded
  if (!isIndexExtended && !isMiddleExtended && !isRingExtended && !isPinkyExtended) {
    return 'FIST';
  }

  // HOVER: everything else
  return 'HOVER';
}

export type GestureUpdateResult = {
  rawGesture: Gesture;
  confirmedGesture: Gesture;
  displayGesture: GestureDisplay;
  fistProgress: number;
  shouldClear: boolean;
};

export class GestureClassifier {
  private confirmedGesture: Gesture = 'HOVER';
  private candidateGesture: Gesture = 'HOVER';
  private candidateCount: number = 0;

  private fistStartTime: number | null = null;
  private fistTriggered: boolean = false;

  public update(
    landmarks: NormalizedLandmark[] | undefined | null,
    timestamp: number
  ): GestureUpdateResult {
    if (!landmarks || landmarks.length < 21) {
      this.reset();
      return {
        rawGesture: 'HOVER',
        confirmedGesture: 'HOVER',
        displayGesture: 'No hand',
        fistProgress: 0,
        shouldClear: false,
      };
    }

    const rawGesture = classifyHand(landmarks);

    // Apply 3-frame hysteresis for state transition
    if (rawGesture !== this.confirmedGesture) {
      if (rawGesture === this.candidateGesture) {
        this.candidateCount += 1;
        if (this.candidateCount >= HYSTERESIS_FRAMES) {
          this.confirmedGesture = this.candidateGesture;
          this.candidateCount = 0;
        }
      } else {
        this.candidateGesture = rawGesture;
        this.candidateCount = 1;
      }
    } else {
      this.candidateGesture = rawGesture;
      this.candidateCount = 0;
    }

    // Handle 1.5s FIST hold & clear logic with trigger latch
    let shouldClear = false;
    let fistProgress = 0;

    if (this.confirmedGesture === 'FIST') {
      if (this.fistStartTime === null) {
        this.fistStartTime = timestamp;
      }
      const elapsed = timestamp - this.fistStartTime;
      fistProgress = Math.min(1, elapsed / FIST_HOLD_DURATION_MS);

      if (fistProgress >= 1 && !this.fistTriggered) {
        this.fistTriggered = true;
        shouldClear = true;
      }
    } else {
      // Release latch and reset timer when leaving FIST
      this.fistStartTime = null;
      this.fistTriggered = false;
      fistProgress = 0;
    }

    let displayGesture: GestureDisplay = 'Hovering';
    if (this.confirmedGesture === 'FIST') {
      displayGesture = 'Clearing';
    } else if (this.confirmedGesture === 'DRAW') {
      displayGesture = 'Drawing';
    } else if (this.confirmedGesture === 'SELECT') {
      displayGesture = 'Selecting';
    }

    return {
      rawGesture,
      confirmedGesture: this.confirmedGesture,
      displayGesture,
      fistProgress,
      shouldClear,
    };
  }

  public reset(): void {
    this.confirmedGesture = 'HOVER';
    this.candidateGesture = 'HOVER';
    this.candidateCount = 0;
    this.fistStartTime = null;
    this.fistTriggered = false;
  }

  public getConfirmedGesture(): Gesture {
    return this.confirmedGesture;
  }
}
