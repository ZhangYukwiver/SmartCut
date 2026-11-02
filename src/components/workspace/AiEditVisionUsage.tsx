import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { summarizeVisionCalls } from '../../../server/aiEdit/visionUsage.mjs';
import { kit } from './CreatorKit';

export function AiEditVisionUsage({ calls = [], cumulative = false }: { calls?: readonly unknown[]; cumulative?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const usage = summarizeVisionCalls(calls);
  if (!usage.calls) return null;
  const tokens = usage.tokens >= 10_000 ? `${(usage.tokens / 10_000).toFixed(2)} 万` : usage.tokens.toLocaleString();
  const partial = usage.unpriced > 0 || usage.missingUsage > 0;
  return <View style={{ gap: 5, paddingVertical: 5 }}>
    <Pressable accessibilityRole="button" accessibilityLabel="查看视觉模型用量说明" onPress={() => setExpanded(v => !v)}>
      <Text style={kit.muted}>{cumulative ? '视觉累计' : '本轮视觉'} · {usage.calls} 次 · {usage.tokens ? `${tokens} Token` : '用量未返回'}
        {usage.knownCostYuan > 0 ? ` · ${partial ? '已知部分' : ''}约 ¥${usage.knownCostYuan.toFixed(2)}` : ' · 费用未估算'}{expanded ? ' ▴' : ' ▾'}</Text>
    </Pressable>
    {expanded ? <Text style={kit.muted}>已记录输入 {usage.input.toLocaleString()}、输出 {usage.output.toLocaleString()} Token（含思考）。{usage.missingUsage ? `${usage.missingUsage} 次未返回完整用量。` : ''}{usage.unpriced ? `${usage.unpriced} 次暂无匹配价格。` : ''}费用按调用时已知地区的公开原价估算，非账单实扣，不含优惠；未计入主剪辑对话、生成素材或本地渲染。复用已保存评审不新增调用。</Text> : null}
  </View>;
}
