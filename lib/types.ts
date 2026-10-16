export type Point = {
  x: number;
  y: number;
  time: number;
};

export type Stroke = {
  points: Point[];
  color: string;
  width: number;
};

export type Gesture = 'DRAW' | 'SELECT' | 'FIST' | 'HOVER';

export type GestureDisplay =
  | 'Drawing'
  | 'Hovering'
  | 'Selecting'
  | 'Clearing'
  | 'No hand';

export type NormalizedLandmark = {
  x: number;
  y: number;
  z?: number;
};

export type VideoMapping = {
  scale: number;
  offsetX: number;
  offsetY: number;
  renderedWidth: number;
  renderedHeight: number;
};

export type CameraStatus = 'idle' | 'loading' | 'ready' | 'error';

export function strokesToJSON(strokes: Stroke[]): string {
  return JSON.stringify(strokes, null, 2);
}
