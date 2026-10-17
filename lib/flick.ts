import { Gesture } from './types';

export const BURST_SPEED = 2.5; // Normalized screen-widths per second
export const BURST_COOLDOWN_MS = 600;

export class FlickTracker {
  private history: Array<{ x: number; y: number; time: number }> = [];
  private lastBurstTime: number = 0;

  public update(
    wristScreenX: number,
    wristScreenY: number,
    containerWidth: number,
    gesture: Gesture,
    timestamp: number
  ): boolean {
    if (containerWidth <= 0) return false;

    // Normalize coordinates by container width
    const nx = wristScreenX / containerWidth;
    const ny = wristScreenY / containerWidth;

    this.history.push({ x: nx, y: ny, time: timestamp });
    if (this.history.length > 3) {
      this.history.shift();
    }

    if (this.history.length < 3) {
      return false;
    }

    // Velocity averaged over the previous 2 frame intervals
    const oldest = this.history[0];
    const newest = this.history[this.history.length - 1];
    const dtSeconds = (newest.time - oldest.time) / 1000;

    if (dtSeconds <= 0.001 || dtSeconds > 0.35) {
      return false;
    }

    const dx = newest.x - oldest.x;
    const dy = newest.y - oldest.y;
    const speed = Math.hypot(dx, dy) / dtSeconds;

    // Trigger burst when fast flick occurs outside of DRAW and FIST states
    if (
      speed > BURST_SPEED &&
      gesture !== 'DRAW' &&
      gesture !== 'FIST' &&
      timestamp - this.lastBurstTime >= BURST_COOLDOWN_MS
    ) {
      this.lastBurstTime = timestamp;
      return true;
    }

    return false;
  }

  public reset(): void {
    this.history = [];
    this.lastBurstTime = 0;
  }
}
