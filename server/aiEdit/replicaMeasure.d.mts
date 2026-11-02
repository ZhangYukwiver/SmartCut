import type { ReplicaReviewLayer } from './replicaReview.mjs';
export type ReplicaMeasurementObject = { id: string; index: number; name: string; eligible: boolean; reason: string | null; covering: boolean; measured?: boolean };
export function replicaMeasurementObjects(layers: ReplicaReviewLayer[]): ReplicaMeasurementObject[];
export function canMeasureReplica(layers: ReplicaReviewLayer[], duration: number): boolean;
export function measureReplica(options: { video: HTMLVideoElement; layers: ReplicaReviewLayer[]; seek: (video: HTMLVideoElement, seconds: number) => Promise<void>; signal?: AbortSignal }): Promise<{ duration: number; layers: ReplicaReviewLayer[]; measured: number; sampleStep?: number; objects: ReplicaMeasurementObject[] }>;
