export class EMAFilter {
  private smoothed: { x: number; y: number } | null = null;
  private alpha: number;

  constructor(alpha: number = 0.35) {
    this.alpha = alpha;
  }

  public setAlpha(alpha: number): void {
    this.alpha = alpha;
  }

  public getAlpha(): number {
    return this.alpha;
  }

  public filter(rawX: number, rawY: number): { x: number; y: number } {
    if (!this.smoothed) {
      this.smoothed = { x: rawX, y: rawY };
      return { ...this.smoothed };
    }

    this.smoothed = {
      x: this.alpha * rawX + (1 - this.alpha) * this.smoothed.x,
      y: this.alpha * rawY + (1 - this.alpha) * this.smoothed.y,
    };

    return { ...this.smoothed };
  }

  public reset(): void {
    this.smoothed = null;
  }
}
