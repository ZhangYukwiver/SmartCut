export type DrawingQuad = [number, number][];
export interface DrawingPaint { coef?: number[][]; range?: number[][]; color?: string; colors?: string[] }
export interface DrawingKey { t: number; paint: DrawingPaint; quad?: DrawingQuad }
export interface DrawingStep { t: number; add?: DrawingQuad[]; replace?: DrawingQuad[]; parts: { quad: DrawingQuad; keys: DrawingKey[]; paintOverride?: boolean }[] }
export interface DrawingLayer {
  type: 'field' | 'opening' | 'panel' | 'mask' | 'signature' | 'text';
  width: number; height: number; offset?: number; content: 'generated' | 'media';
  referenceId?: string; referenceStart?: number;
  text: string; fontSize: number; showText: boolean; echo?: boolean; plain?: boolean; textColor?: string; sharedPaint?: boolean;
  keys?: DrawingKey[]; steps?: DrawingStep[]; fullAt?: number; quad?: DrawingQuad;
  center?: [number, number]; numberAt?: number; fadeEnd?: number;
}
export function drawingProblem(d: unknown): string | null;
export function drawingTimes(d?: DrawingLayer): number[];
export function createDrawingRenderer(canvas: HTMLCanvasElement): (drawing: DrawingLayer, localTime: number, source?: HTMLImageElement | HTMLVideoElement | null, fit?: string) => void;
export function drawingTransform(segment: object, offset: number): Record<string, number | boolean>;
export function drawingPage(segment: object, stage: { width: number; height: number }, sourceUrl?: string | null): string;
