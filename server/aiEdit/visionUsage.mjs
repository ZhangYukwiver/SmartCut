// 公开原价只是估算；未知模型/地区不猜价格，也不将缺失用量填成零。
export const VISION_PRICE_SOURCE = 'https://help.aliyun.com/zh/model-studio/qwen3-8-max';
export function priceVisionCall(call, config) {
  let host;
  try { host = new URL(config.baseUrl).hostname; } catch { return; }
  if (!/^qwen3\.8-max(?:-0902|-2026-09-02)?$/u.test(call.model ?? '')
    || !(host === 'dashscope.aliyuncs.com' || host.endsWith('.cn-beijing.maas.aliyuncs.com'))) return;
  call.priceBasis = { currency: 'CNY', inputPerMillion: 12, cachedPerMillion: 1.5, outputPerMillion: 36, date: '2026-10-31', source: VISION_PRICE_SOURCE };
}

export function summarizeVisionCalls(calls = []) {
  const unique = new Map(calls.filter(c => c && typeof c === 'object').map(c => [`${c.startedAt}|${c.model}|${c.input}`, c]));
  const total = { calls: unique.size, input: 0, output: 0, tokens: 0, knownCostYuan: 0, missingUsage: 0, unpriced: 0 };
  for (const c of unique.values()) {
    const attempts = c.attempts?.some(a => a.usage) ? c.attempts.filter(a => a.usage).map(a => a.usage) : c.usage ? [c.usage] : [];
    if (!attempts.length) { total.missingUsage++; continue; }
    const priced = c.priceBasis?.currency === 'CNY';
    if (!priced) total.unpriced++;
    for (const u of attempts) {
      const input = u.prompt_tokens ?? u.input_tokens, output = u.completion_tokens ?? u.output_tokens;
      if (!Number.isFinite(input) || !Number.isFinite(output)) { total.missingUsage++; continue; }
      total.input += input; total.output += output;
      total.tokens += input + output;
      if (priced) {
        const cached = Math.min(input, Math.max(0, u.prompt_tokens_details?.cached_tokens ?? 0)), p = c.priceBasis;
        total.knownCostYuan += ((input - cached) * p.inputPerMillion + cached * p.cachedPerMillion + output * p.outputPerMillion) / 1e6;
      }
    }
  }
  return total;
}
