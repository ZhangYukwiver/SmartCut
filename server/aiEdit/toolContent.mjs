// 本轮工具的多模态材料只在内存中传递；JSON 历史不写入截图 base64。
// Symbol 在对象展开时保留，在 JSON.stringify 时忽略。
export const TOOL_CONTENT = Symbol('reellab.toolContent');
