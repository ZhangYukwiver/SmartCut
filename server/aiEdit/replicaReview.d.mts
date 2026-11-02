import type { DrawingLayer } from './drawing.mjs';
export interface ReplicaReviewLayer {
  name: string; start: number; duration: number; drawing: DrawingLayer; extraction?: number; fit?: 'cover' | 'contain' | 'stretch';
  keyframes?: { property: string; offset: number; value: number; curve?: number[] }[];
  transform?: Record<string, number | boolean> | null;
  media?: { url: string; kind: 'image' | 'video'; start: number; speed: number; fit: string };
}
export function reviewReplica(options: {
  video?: HTMLVideoElement; url?: string; layers: ReplicaReviewLayer[]; crops?: { time: number; crop: number[] }[];
  signal?: AbortSignal; origin?: number;
  canvas?: { width: number; height: number; fps?: number };
}): Promise<{ duration: number; coverage: 'all-frames'; frameCount: number; renderFps: number; requiredFps: number;
  meanError: number; localError: number; temporalError: number; worstError: number;
  samples: { frame: number; t: number; duration: number; renderedAt: number; error: number; localError: number; temporalError: number }[];
  sheets: { times: number[]; image: string }[]; detailSheets: { times: number[]; image: string }[];
  temporalSheets: { times: number[]; image: string; frames: number[]; peakFrame: number }[];
  windows: { peak: number; start: number; end: number; error: number }[];
  regionMeasurements: { layer: number; name: string; step: number; polygon_index: number | null; trackedFromStep?: number; frame: number; t: number; localTime: number; currentBounds: number[]; reference: { bounds: number[]; color: string; edgeStrength: number } }[];
}>;
