import { type AiEditLookJob, type AiRuntime, type LocalAiRuntime, aiConfigReady, aiRequestConfig, aiRuntimeOf, isLocalAiRuntime, loadAiEditConfig, pickLocalModels, videoProbeKey } from "./aiEdit";
import { ServerError, serverFetch, normalizeServerBaseUrl, type Connection } from "./connection";
import type { Handoff } from "../desktopRuntime";

// 解析库：页面把素材库里一条视频的 id 和接口配置交给本机服务，服务调用 AI、存结果（server/videoAnalysis.mjs）。
// 接口配置存在本机 localStorage，每次随请求带过去，服务不保存 Key。这份配置就是 AI 剪辑设置「服务商」里的「解析视频」：
// AI 剪辑看参考视频、转写字幕也用它；两边都没单独连时用 AI 剪辑的剪辑模型。

export interface AnalysisConfig {
  /** 没有就是接口；也可以用这台电脑上登录好的 Codex / Claude Code */
  runtime?: AiRuntime;
  /** 本机 CLI 的模型（选填），和接口的分开存 */
  localModels?: Partial<Record<LocalAiRuntime, string>>;
  baseUrl: string;
  apiKey: string;
  model: string;
  direction: string;
  /** 保存时测过：模型能不能直接看视频（看不了的话由解析库页面把视频拆成截图和节拍再给它）；没测过是 null */
  videoInput?: boolean | null;
  imageInput?: boolean | null;
  /** 测的是哪个接口地址和模型，换了就要重测 */
  videoProbe?: string;
}

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  apiKey: "",
  // 10-09 实测比 2.0 mini 细得多（原话、时间戳、10 个维度都答全），代价是一条要几分钟
  model: "doubao-seed-2-1-lite-260915",
  direction: "",
};

export interface AnalysisVideo {
  title: string | null; author: string | null; durationSeconds: number | null;
  url?: string | null; description?: string | null;
  /** 旧版迁过来的条目还带着这些 */
  videoId?: string | null; publishedAt?: string | null; tags?: string[]; cover?: string | null;
  stats?: { playCount?: number; diggCount?: number; commentCount?: number; shareCount?: number; collectCount?: number } | null;
}

export interface VideoAnalysis {
  id: string;
  /** 解析的是素材库里哪条视频；旧版迁过来的条目没有，只能看和删，不能重新解析 */
  mediaId: string | null;
  /** 原视频页面地址（送来的视频带着的，或旧条目的链接）；没有是 null */
  sourceUrl: string | null;
  status: "running" | "complete" | "failed";
  stage: "analyzing" | "looking" | "squeezing" | null;
  /** 模型看不了视频时，服务请这个页面在浏览器里拆视频（截图、节拍） */
  look?: AiEditLookJob;
  video: AnalysisVideo | null;
  model: string;
  markdown: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const CONFIG_KEY = "reellab.analysisConfig";
export function loadAnalysisConfig(): AnalysisConfig {
  try {
    const config: AnalysisConfig = { ...DEFAULT_ANALYSIS_CONFIG, ...JSON.parse(globalThis.localStorage?.getItem(CONFIG_KEY) ?? "{}") };
    if (config.runtime !== undefined) config.runtime = aiRuntimeOf(config.runtime);
    const localModels = pickLocalModels(config.localModels);
    if (localModels) config.localModels = localModels;
    else delete config.localModels;
    // 测的不是现在这个模型就当没测过
    if (config.videoProbe !== videoProbeKey(config)) {
      delete config.videoInput;
      delete config.videoProbe;
      delete config.imageInput;
    }
    if (typeof config.videoInput !== "boolean") delete config.videoInput;
    if (typeof config.imageInput !== "boolean") delete config.imageInput;
    return config;
  } catch {
    return DEFAULT_ANALYSIS_CONFIG;
  }
}
export function saveAnalysisConfig(config: AnalysisConfig) {
  try { globalThis.localStorage?.setItem(CONFIG_KEY, JSON.stringify(config)); } catch { /* 存不了就只管这一次 */ }
}

/** 解析时实际用的那份：「解析视频」单独连了就用它，没连用 AI 剪辑的剪辑模型（创作方向还是解析库填的）；都没配好是 null。 */
export function analysisInUse(): AnalysisConfig | null {
  const own = loadAnalysisConfig();
  if (aiConfigReady(own)) return own;
  const edit = loadAiEditConfig();
  return aiConfigReady(edit) ? { ...edit, direction: own.direction } : null;
}

async function request(connection: Connection, path: string, init: RequestInit = {}): Promise<any> {
  let response: Response;
  try {
    response = await serverFetch(connection, `${path}`, {
      ...init,
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ServerError("analysis_unreachable", "本机服务没连上，请稍后重试。");
  }
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new ServerError(value?.error ?? "analysis_failed", value?.message ?? (
    response.status === 401 ? "连接已过期，请重启拆片工坊。" : "解析请求失败，请稍后重试。"));
  return value;
}

export async function listAnalyses(connection: Connection): Promise<VideoAnalysis[]> {
  const value = await request(connection, "/v1/analyses");
  return Array.isArray(value?.analyses) ? value.analyses : [];
}

/** 随解析一起交过去的视频说明（送来的视频才有）：模型拿它当背景，不是必填 */
export interface AnalysisVideoInput { title?: string; author?: string; url?: string; description?: string; durationSeconds?: number }

/**
 * 解析素材库里的一条视频（mediaId 要是已就绪的视频，不然服务回 404 media_not_found / 422 media_not_video）。
 * 同一条再解析会覆盖原来的结果；还在解析就原样返回那一条。
 */
export async function startAnalysis(connection: Connection, mediaId: string, config: AnalysisConfig, video?: AnalysisVideoInput): Promise<VideoAnalysis> {
  // 本机 CLI 只带运行时、模型和创作方向
  const sent = isLocalAiRuntime(config.runtime) ? { ...aiRequestConfig(config), direction: config.direction } : aiRequestConfig(config);
  return (await request(connection, "/v1/analyses", { method: "POST", body: JSON.stringify({ mediaId, config: sent, ...(video ? { video } : {}) }) })).analysis;
}

/** 送来的视频随解析一起交过去的说明：只放有值的几项 */
export function handoffVideo(handoff: Handoff): AnalysisVideoInput {
  return {
    ...(handoff.title ? { title: handoff.title } : {}),
    ...(handoff.author ? { author: handoff.author } : {}),
    ...(handoff.url ? { url: handoff.url } : {}),
    ...(handoff.description ? { description: handoff.description } : {}),
    ...(handoff.durationSeconds ? { durationSeconds: handoff.durationSeconds } : {}),
  };
}

/**
 * 送来的视频能不能一到就开始解析：和手动点「解析」一样看 analysisInUse，就绪就回这次要用的配置和视频说明；
 * 没就绪是 null，页面把它摆出来等用户配好模型再点开始。本机 Codex / Claude Code 装没装、登没登录由页面另外查。
 */
export function handoffStart(handoff: Handoff): { config: AnalysisConfig; video: AnalysisVideoInput } | null {
  const config = analysisInUse();
  return config ? { config, video: handoffVideo(handoff) } : null;
}

export async function deleteAnalysis(connection: Connection, id: string): Promise<void> {
  await request(connection, `/v1/analyses/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// 只认 AI 回答里会出现的几种写法：标题、表格、列表、引用、分隔线、**加粗**。
export type MarkdownBlock = { kind: "h"; level: number; text: string } | { kind: "p" | "quote"; text: string } | { kind: "li"; marker: string; text: string } | { kind: "table"; rows: string[][] } | { kind: "hr" };

// 模型有时照抄提示词里的“维度｜具体发现｜…”，整张表只用全角竖线、行首也不带竖线
const isRow = (line: string) => /^[|｜]/u.test(line.trim()) || (line.match(/｜/gu)?.length ?? 0) >= 2;
const cells = (line: string) => line.trim().replace(/^[|｜]|[|｜]$/gu, "").split(/[|｜]/u).map((cell) => cell.trim().replace(/<br\s*\/?>/giu, "\n"));

export function parseMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) blocks.push({ kind: "p", text: paragraph.join("\n") }); paragraph = []; };
  const lines = text.replace(/\r/gu, "").split("\n");
  const at = (index: number) => (lines[index] ?? "").trim();
  for (let index = 0; index < lines.length; index += 1) {
    const line = at(index);
    let match: RegExpMatchArray | null;
    if (!line || line.startsWith("```")) { flush(); continue; }
    if (isRow(line)) {
      flush();
      const rows: string[][] = [];
      // 表头下面那行 |---|---| 不算内容
      for (; index < lines.length && isRow(at(index)); index += 1) if (!/^[|｜:\s-]+$/u.test(at(index))) rows.push(cells(at(index)));
      index -= 1;
      blocks.push({ kind: "table", rows });
    } else if ((match = line.match(/^(#{1,6})\s+(.*)$/u))) { flush(); blocks.push({ kind: "h", level: match[1]!.length, text: match[2]! }); }
    else if (/^(-{3,}|\*{3,}|_{3,})$/u.test(line)) { flush(); blocks.push({ kind: "hr" }); }
    else if ((match = line.match(/^>\s?(.*)$/u))) { flush(); blocks.push({ kind: "quote", text: match[1]! }); }
    else if ((match = line.match(/^([-*+]|\d+[.)、])\s+(.*)$/u))) { flush(); blocks.push({ kind: "li", marker: /\d/u.test(match[1]!) ? match[1]! : "•", text: match[2]! }); }
    else paragraph.push(line);
  }
  flush();
  return blocks;
}

/** 把解析库页面拆好的截图和节拍（或接手、进度回执、拆不了的原因）交回本机服务。 */
export async function answerAnalysisLook(connection: Connection, id: string, lookId: string, body: unknown): Promise<void> {
  await request(connection, `/v1/analyses/${encodeURIComponent(id)}/look/${encodeURIComponent(lookId)}`, { method: "POST", body: JSON.stringify(body) });
}

/** 服务给的是路径（里面的随机串就是凭证），补上根地址。 */
export const analysisLookUrl = (baseUrl: string, path: string): string => `${normalizeServerBaseUrl(baseUrl)}${path}`;

/** 解析库挂着的拆视频任务（只有任务，不带整份结果），应用开着就接。 */
export async function listPendingAnalysisLooks(connection: Connection): Promise<{ id: string; look: AiEditLookJob }[]> {
  const value = await request(connection, "/v1/analyses/looks");
  return Array.isArray(value?.looks) ? value.looks : [];
}
