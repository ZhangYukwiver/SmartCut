export const VISION_PRICE_SOURCE: string;
export function summarizeVisionCalls(calls?: readonly unknown[]): { calls: number; input: number; output: number; tokens: number; knownCostYuan: number; missingUsage: number; unpriced: number };
export function priceVisionCall(call: Record<string, unknown>, config: { baseUrl?: string }): void;
