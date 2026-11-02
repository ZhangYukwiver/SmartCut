export function replicaInput(url: string, signal?: AbortSignal): Promise<{
  duration: number; width: number; height: number; frameCount: number; sampleStep: number;
  sheets: { times: number[]; image: string; detail?: string }[];
  samples: { frame: number; t: number; duration: number; change: number }[];
}>;
