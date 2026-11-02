import { expect, it } from 'vitest';
import { priceVisionCall, summarizeVisionCalls } from './visionUsage.mjs';

it('deduplicates cumulative records, prices known Beijing usage and keeps unknown costs explicit', () => {
  const call = { startedAt: 'now', model: 'qwen3.8-max', input: 'video', usage: { prompt_tokens: 17378, completion_tokens: 4690 } };
  priceVisionCall(call, { baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/v1', apiKey: 'never-log-me' });
  const result = summarizeVisionCalls([call, structuredClone(call), { startedAt: 'later', model: 'unknown', usage: { input_tokens: 10, output_tokens: 5 } }, { startedAt: 'failed', model: 'unknown' }]);
  expect(result).toMatchObject({ calls: 3, input: 17388, output: 4695, missingUsage: 1, unpriced: 1 });
  expect(result.knownCostYuan).toBeCloseTo(.377376);
  expect(JSON.stringify(call)).not.toContain('never-log-me');
  const overseas = { ...call, priceBasis: undefined }; priceVisionCall(overseas, { baseUrl: 'https://dashscope-intl.aliyuncs.com/v1' });
  expect(overseas.priceBasis).toBeUndefined();
});
