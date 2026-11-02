import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { ArrowUpRight, Copy, FolderOpen, RefreshCw, Settings2, Sparkles, Trash2, X } from "lucide-react-native";
import type { Connection } from "../../services/connection";
import type { Handoff } from "../../desktopRuntime";
import { aiConfigReady, aiRuntimeOf, isLocalAiRuntime, loadAiEditConfig, probeAiEditVideo, uploadAiEditMedia, videoProbeKey } from "../../services/aiEdit";
import {
  analysisInUse, analysisLookUrl, answerAnalysisLook, deleteAnalysis, handoffStart, listAnalyses, loadAnalysisConfig, saveAnalysisConfig, startAnalysis,
  type AnalysisConfig, type AnalysisVideoInput, type VideoAnalysis,
} from "../../services/videoAnalysis";
import { dropLookJobs, runLookJob } from "./aiEditLook";
import { errorText, web, webPointer } from "./aiEditShared";
import { AiRuntimeField, RUNTIME_LABELS, runtimeProblem } from "./AiRuntimeField";
import { Empty, ErrorLine, kit, Panel, SmallButton } from "./CreatorKit";
import { Markdown } from "./markdownView";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { ws } from "./motion";

// 解析库：选一个本机视频（或拖进来），先传进 AI 剪辑的素材库，再交给 AI 按创作者视角拆解；
// 别的应用送来的视频也在这里解析。结果都留在这里。

type Props = {
  connection: Connection | null;
  /** 别的应用送来、还没开始解析的视频；开始解析了或用户不要了就用 onHandoffDone 交回，App 从队里拿掉 */
  handoffs: Handoff[];
  onHandoffDone: (mediaId: string) => void;
  onReconnect: () => void;
};

const stageText = (item: VideoAnalysis) => item.status === "failed" ? "没解析成功"
  : item.status === "complete" ? "已解析" : item.stage === "looking" ? "正在把视频拆成截图和节拍…"
    : item.stage === "squeezing" ? "视频太大，接口收不下，正在压缩一份小的…"
    : item.stage === "analyzing" ? "AI 正在看视频…" : "正在准备…";

const isVideoFile = (file: File) => file.type.startsWith("video/") || /\.(?:mp4|mov|m4v|webm|mkv)$/iu.test(file.name);

/** 重新解析时把上次的视频说明带回去，免得覆盖后标题、作者、简介没了 */
export function videoOf(item: VideoAnalysis): AnalysisVideoInput {
  const video = item.video;
  return {
    ...(video?.title ? { title: video.title } : {}),
    ...(video?.author ? { author: video.author } : {}),
    ...(item.sourceUrl ? { url: item.sourceUrl } : {}),
    ...(video?.description ? { description: video.description } : {}),
    ...(video?.durationSeconds ? { durationSeconds: video.durationSeconds } : {}),
  };
}

// 测模型能不能看视频：整个页面共用，切走再回来不重复测（「地址|模型|Key」）
const probing = new Set<string>();
const probeTried = new Set<string>();

type Probe = { key: string; running: boolean; error?: string };

export function videoInputNote(config: AnalysisConfig, probe: Probe): string {
  if (probe.running) return "正在测这个模型能不能直接看视频……";
  const known = config.videoInput === true ? "已测出支持视频画面；音轨理解能力未单独验证。"
    : config.videoInput === false ? "这个模型看不了视频。解析时应用会先把视频拆成镜头截图和音乐节拍再交给它，听不到台词和旁白，这时要开着应用。"
      : null;
  if (probe.error) return known ? `这次没测出来（${probe.error}），先沿用上次的结果：${known}` : `没测出这个模型能不能直接看视频（${probe.error}）。解析时会先整段发给它，看不了再拆成截图。`;
  return known ?? "还没测过这个模型能不能直接看视频。";
}

/**
 * 「解析视频」这份配置（解析库和 AI 剪辑设置的「服务商」共用，存在 reellab.analysisConfig）：读写、测模型能不能看视频。
 * save 收的是草稿：去掉首尾空格；接口地址和模型没变就沿用测过的结果，变了会自动重测。
 */
export function useAnalysisService(connection: Connection | null) {
  const [config, setConfig] = useState<AnalysisConfig>(loadAnalysisConfig);
  const [probe, setProbe] = useState<Probe>({ key: "", running: false });
  const configRef = useRef(config);
  configRef.current = config;
  // 每个接口地址+模型测一次能不能看视频（保存时、以前存的没测过时）
  const probeVideo = useCallback(async (target: AnalysisConfig) => {
    const key = videoProbeKey(target);
    const attempt = `${key}|${target.apiKey}`;
    if (!connection || probing.has(attempt)) return;
    probing.add(attempt);
    setProbe({ key, running: true });
    const settle = (next: Probe) => setProbe((current) => (current.key === key ? next : current));
    try {
      const { videoInput } = await probeAiEditVideo(connection, target);
      const stored = loadAnalysisConfig();
      if (videoProbeKey(stored) === key) saveAnalysisConfig({ ...stored, videoInput, videoProbe: key });
      setConfig((current) => (videoProbeKey(current) === key ? { ...current, videoInput, videoProbe: key } : current));
      settle({ key, running: false });
    } catch (reason) {
      settle({ key, running: false, error: reason instanceof Error ? reason.message : "没测出来，请稍后重试。" });
    } finally {
      probing.delete(attempt);
    }
  }, [connection]);
  useEffect(() => {
    const attempt = `${videoProbeKey(config)}|${config.apiKey}`;
    // 本机的 Codex / Claude Code 都看不了视频，不用测
    if (!connection || isLocalAiRuntime(config.runtime) || !config.apiKey.trim() || typeof config.videoInput === "boolean" || probeTried.has(attempt)) return;
    probeTried.add(attempt);
    void probeVideo(config);
  }, [connection, config, probeVideo]);
  const save = useCallback((draft: AnalysisConfig) => {
    const runtime = aiRuntimeOf(draft.runtime);
    const models = draft.localModels ? Object.fromEntries(Object.entries(draft.localModels).map(([key, model]) => [key, (model ?? "").trim()])) : undefined;
    const saved = { ...draft, runtime, apiKey: draft.apiKey.trim(), model: draft.model.trim(), baseUrl: draft.baseUrl.trim(), ...(models ? { localModels: models } : {}) };
    const current = configRef.current;
    const next = videoProbeKey(saved) === current.videoProbe ? { ...saved, videoInput: current.videoInput, videoProbe: current.videoProbe } : { ...saved, videoInput: undefined, videoProbe: undefined };
    saveAnalysisConfig(next);
    setConfig(next);
  }, []);
  return { config, save, probe: probe.key === videoProbeKey(config) ? probe : { key: "", running: false }, retest: () => void probeVideo(configRef.current) };
}
export type AnalysisService = ReturnType<typeof useAnalysisService>;

export function AnalysisWorkspace({ connection, handoffs, onHandoffDone, onReconnect }: Props) {
  const { width } = useWindowDimensions();
  const narrow = width < 1000;
  const [items, setItems] = useState<VideoAnalysis[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const service = useAnalysisService(connection);
  // 「解析视频」没单独连、AI 剪辑的剪辑模型也没配好时一进来就开着设置
  const [editing, setEditing] = useState(() => !analysisInUse());
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // 正在传进素材库的本机视频
  const [upload, setUpload] = useState<{ name: string; progress: number } | null>(null);
  const [dropping, setDropping] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<View>(null);

  const refresh = useCallback(async () => {
    if (!connection) return;
    try {
      setItems(await listAnalyses(connection));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "解析库没读到，请稍后重试。");
    } finally {
      setLoaded(true);
    }
  }, [connection]);
  useEffect(() => { void refresh(); }, [refresh]);
  // 有解析中的就每 3 秒刷一次
  const running = items.some((item) => item.status === "running");
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [running, refresh]);

  // 模型看不了视频时，服务把活儿挂在解析记录上：这个页面在浏览器里拆好交回
  useEffect(() => {
    if (!connection) return;
    for (const item of items) {
      const look = item.status === "running" ? item.look ?? null : null;
      dropLookJobs(item.id, look?.id ?? null);
      if (look) runLookJob(item.id, look, analysisLookUrl(connection.baseUrl, look.url), (body) => answerAnalysisLook(connection, item.id, look.id, body));
    }
  }, [connection, items]);

  const shown = useMemo(() => {
    const words = query.trim().toLocaleLowerCase();
    if (!words) return items;
    return items.filter((item) => [item.video?.title, item.video?.author, item.video?.tags?.join(" "), item.markdown]
      .some((text) => text?.toLocaleLowerCase().includes(words)));
  }, [items, query]);
  const selected = shown.find((item) => item.id === selectedId) ?? shown[0] ?? null;

  /** 解析素材库里的一条视频；开始了回 true */
  const begin = async (mediaId: string, video?: AnalysisVideoInput): Promise<boolean> => {
    if (!connection) return false;
    // 现读：AI 剪辑设置里可能刚改过同一份
    const config = analysisInUse();
    if (!config) { setEditing(true); setError("先在 AI 设置里填好 Key 和模型再解析。"); return false; }
    const problem = await runtimeProblem(connection, config.runtime);
    if (problem) { setEditing(true); setError(problem); return false; }
    setStarting(true);
    try {
      const entry = await startAnalysis(connection, mediaId, config, video);
      setSelectedId(entry.id);
      await refresh();
      return true;
    } catch (reason) {
      setError(errorText(reason, "解析没开始，请稍后重试。"));
      return false;
    } finally {
      setStarting(false);
    }
  };

  /** 本机视频：先传进素材库拿到 id，再开始解析。没配好模型就先别传 */
  const analyzeFile = async (file: File) => {
    if (!connection || upload) return;
    if (!isVideoFile(file)) { setError("只能解析视频文件。"); return; }
    if (!analysisInUse()) { setEditing(true); setError("先在 AI 设置里填好 Key 和模型再解析。"); return; }
    setError(null);
    setUpload({ name: file.name, progress: 0 });
    try {
      const item = await uploadAiEditMedia(connection, file, (progress) => setUpload({ name: file.name, progress }));
      await begin(item.id, { title: file.name.replace(/\.[^.]+$/u, "") });
    } catch (reason) {
      setError(errorText(reason, "视频没传上去，请稍后重试。"));
    } finally {
      setUpload(null);
    }
  };
  const analyzeRef = useRef(analyzeFile);
  analyzeRef.current = analyzeFile;

  // 送来的视频：解析配置就绪就直接开始，没就绪就摆在上面，等用户配好模型再点开始（每条只自动试一次）
  const tried = useRef(new Set<string>());
  const beginRef = useRef(begin);
  beginRef.current = begin;
  useEffect(() => {
    if (!connection) return;
    for (const handoff of handoffs) {
      if (tried.current.has(handoff.mediaId)) continue;
      tried.current.add(handoff.mediaId);
      const plan = handoffStart(handoff);
      if (!plan) { setEditing(true); continue; }
      void beginRef.current(handoff.mediaId, plan.video).then((ok) => { if (ok) onHandoffDone(handoff.mediaId); });
    }
  }, [connection, handoffs, onHandoffDone]);
  const startHandoff = async (handoff: Handoff) => {
    if (await begin(handoff.mediaId, handoffStart(handoff)?.video)) onHandoffDone(handoff.mediaId);
  };

  const remove = async (id: string) => {
    if (!connection) return;
    try { await deleteAnalysis(connection, id); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : "没删掉，请稍后重试。"); }
  };

  // 视频文件拖进页面就解析；拖到页面别处的文件不让窗口打开它
  useEffect(() => {
    const zone = rootRef.current as unknown as HTMLElement | null;
    if (!web || !connection || !zone?.addEventListener) return undefined;
    const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    let depth = 0;
    const enter = (event: DragEvent) => { if (carriesFiles(event)) { depth += 1; setDropping(true); } };
    const leave = (event: DragEvent) => { if (carriesFiles(event)) { depth = Math.max(0, depth - 1); if (!depth) setDropping(false); } };
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = zone.contains(event.target as Node | null) ? "copy" : "none";
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDropping(false);
      const file = Array.from(event.dataTransfer?.files ?? []).find(isVideoFile) ?? event.dataTransfer?.files[0];
      if (zone.contains(event.target as Node | null) && file) void analyzeRef.current(file);
    };
    zone.addEventListener("dragenter", enter);
    zone.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      zone.removeEventListener("dragenter", enter);
      zone.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [connection]);

  if (!connection) return <View style={styles.root}><View style={[styles.content, styles.gate]}>
    <Sparkles size={34} color={color.accent} /><Text style={styles.gateTitle}>还没连上本机服务</Text>
    <Text style={kit.body}>视频和解析结果都存在这台电脑上的拆片工坊服务里，连上就能解析。</Text><SmallButton label="重试连接" onPress={onReconnect} />
  </View></View>;

  const busy = starting || upload !== null;
  return <View ref={rootRef} testID="analysis-workspace" style={styles.root}>
    <ScrollView style={styles.root} contentContainerStyle={[styles.content, width < 760 && styles.contentNarrow]}>
      <View {...ws("e-box", "an-bar")} style={styles.bar}>
        <SmallButton label={upload ? `正在上传 ${Math.round(upload.progress * 100)}%` : starting ? "提交中…" : "选择视频文件"} disabled={busy} onPress={() => inputRef.current?.click()}>
          {busy ? <ActivityIndicator size="small" color={color.textMuted} /> : <FolderOpen size={14} color={color.text} />}
        </SmallButton>
        <Text numberOfLines={1} style={[kit.muted, styles.barHint]}>{upload ? upload.name : "也可以把视频拖进来，传进素材库后交给 AI 拆解"}</Text>
        <SmallButton label="AI 设置" onPress={() => setEditing((value) => !value)}><Settings2 size={14} color={color.text} /></SmallButton>
        {web ? <input ref={inputRef} type="file" accept="video/*,.mkv" style={{ display: "none" }}
          onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void analyzeFile(file); }} /> : null}
      </View>
      {handoffs.map((handoff) => <View key={handoff.mediaId} {...ws("e-box")} style={styles.handoff}>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text numberOfLines={2} style={styles.itemTitle}>{`送来的视频「${handoff.title || "没有标题"}」`}</Text>
          <Text style={kit.muted}>{analysisInUse() ? "点「开始解析」交给 AI。" : "先在下面的 AI 设置里配好模型，再点「开始解析」。"}</Text>
        </View>
        <SmallButton label="开始解析" disabled={busy} onPress={() => void startHandoff(handoff)}><Sparkles size={14} color={color.text} /></SmallButton>
        <Pressable accessibilityRole="button" accessibilityLabel={`不解析「${handoff.title || "送来的视频"}」`} hitSlop={8} onPress={() => onHandoffDone(handoff.mediaId)} style={webPointer}>
          <X size={14} color={color.textMuted} />
        </Pressable>
      </View>)}
      {editing ? <ConfigPanel connection={connection} service={service} onSaved={() => setError(null)} onClose={analysisInUse() ? () => setEditing(false) : undefined} /> : null}
      {error ? <ErrorLine text={error} onRetry={() => { setError(null); void refresh(); }} /> : null}

      {!loaded ? <ActivityIndicator color={color.cyan} /> : items.length === 0 ? <Empty lines={["解析库还是空的。", "选一个本机视频文件或者拖进来；别的应用送来的视频也会在这里解析。"]} /> : <View style={[styles.columns, narrow && styles.columnsNarrow]}>
        <View style={[styles.list, narrow && styles.listNarrow]}>
          <TextInput accessibilityLabel="搜索解析库" value={query} onChangeText={setQuery} placeholder="搜标题、作者、词条或拆解内容" placeholderTextColor={color.textMuted} style={[styles.input, styles.search]} />
          <Text style={kit.muted}>{query.trim() ? `找到 ${shown.length} 条` : `一共解析了 ${items.length} 条视频`}</Text>
          {shown.map((item) => {
            const on = item.id === selected?.id;
            return <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => setSelectedId(item.id)} {...ws("e-box", "an-item", on && "on")} style={[styles.item, on && styles.itemOn]}>
              <Text numberOfLines={2} style={styles.itemTitle}>{item.video?.title || item.sourceUrl || "没有标题的视频"}</Text>
              <View style={kit.row}>
                {item.status === "running" ? <ActivityIndicator size="small" color={color.cyan} /> : null}
                <Text style={[kit.muted, item.status === "failed" && { color: color.danger }]}>{stageText(item)}</Text>
                {item.video?.author ? <Text numberOfLines={1} style={kit.muted}>· {item.video.author}</Text> : null}
              </View>
            </Pressable>;
          })}
        </View>
        {selected ? <Detail
          item={selected}
          busy={busy}
          onRetry={selected.mediaId ? () => void begin(selected.mediaId!, videoOf(selected)) : undefined}
          onRemove={() => void remove(selected.id)}
          onOpen={selected.sourceUrl ? () => void Linking.openURL(selected.sourceUrl!) : undefined}
        /> : null}
      </View>}
    </ScrollView>
    {dropping ? <View pointerEvents="none" style={styles.dropMask}><Text style={styles.dropText}>松开就传进素材库，交给 AI 解析</Text></View> : null}
  </View>;
}

function ConfigPanel({ connection, service, onSaved, onClose }: {
  connection: Connection | null;
  service: AnalysisService;
  onSaved: () => void;
  onClose?: () => void;
}) {
  const { config, probe } = service;
  const [draft, setDraft] = useState(config);
  // 保存后面板留着显示测的结果，按钮上闪一下「已保存」
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return undefined;
    const timer = setTimeout(() => setSaved(false), 1600);
    return () => clearTimeout(timer);
  }, [saved]);
  const field = (key: "apiKey" | "model" | "baseUrl" | "direction", label: string, props: Partial<React.ComponentProps<typeof TextInput>> = {}) => <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} value={draft[key]} onChangeText={(text) => setDraft((current) => ({ ...current, [key]: text }))} placeholderTextColor={color.textMuted} style={[styles.input, styles.fieldInput, props.multiline && styles.multiline]} {...props} />
  </View>;
  const runtime = aiRuntimeOf(draft.runtime);
  const local = isLocalAiRuntime(runtime);
  const save = () => {
    service.save(draft);
    onSaved();
    setSaved(true);
  };
  // 没单独填、AI 剪辑配好了剪辑模型：现在解析用的就是它
  const edit = aiConfigReady(config) ? null : loadAiEditConfig();
  const borrowed = edit && aiConfigReady(edit) ? (isLocalAiRuntime(edit.runtime) ? RUNTIME_LABELS[edit.runtime] : edit.model) : null;
  return <Panel title="AI 设置" subtitle={`${local
    ? `用这台电脑上登录好的 ${RUNTIME_LABELS[runtime]} 来解析，走你自己的订阅，不用填 Key。`
    : "填写解析用大模型的接口地址、模型名称和 API Key。模型最好能直接看视频（看不了的会改成看截图和节拍），Key 只存在这台电脑上。"}这就是 AI 剪辑设置「服务商」里的「解析视频」，AI 剪辑看参考视频也用它，在哪边改都一样。${borrowed
    ? `现在这里没填，解析用的是 AI 剪辑的剪辑模型（${borrowed}）。` : ""}`}>
    <AiRuntimeField connection={connection} value={runtime} onChange={(next) => setDraft((current) => ({ ...current, runtime: next }))} />
    {local ? <View style={styles.field}>
      <Text style={styles.label}>模型（选填）</Text>
      <TextInput accessibilityLabel="模型（选填）" value={draft.localModels?.[runtime] ?? ""} onChangeText={(text) => setDraft((current) => ({ ...current, localModels: { ...current.localModels, [runtime]: text } }))}
        placeholder={`留空就用 ${RUNTIME_LABELS[runtime]} 自己的默认模型`} placeholderTextColor={color.textMuted} style={[styles.input, styles.fieldInput]} />
    </View> : <>
      {field("apiKey", "API Key", { secureTextEntry: true, placeholder: "从大模型服务商获取 API Key" })}
      {field("model", "模型", { placeholder: "doubao-seed-2-1-lite-260915" })}
      {field("baseUrl", "接口地址", { placeholder: "https://ark.cn-beijing.volces.com/api/v3" })}
    </>}
    {field("direction", "我的创作方向（选填）", { multiline: true, maxLength: 600, placeholder: "比如：上班族的 10 分钟快手菜，口播加实拍。填了以后改编建议会贴着这个方向写。" })}
    <View style={kit.row}>
      <SmallButton label={saved ? "已保存" : "保存"} done={saved} disabled={!aiConfigReady({ ...draft, runtime })} onPress={save} />
      {onClose ? <SmallButton label="收起" onPress={onClose} /> : null}
    </View>
    {local ? <Text style={kit.muted}>{`${RUNTIME_LABELS[runtime]} 看不了视频：解析时应用会先把视频拆成镜头截图和音乐节拍再交给它，听不到台词和旁白，这时要开着应用。`}</Text>
      : !isLocalAiRuntime(config.runtime) && config.apiKey ? <View style={styles.probeRow}>
        <Text style={[kit.muted, { flex: 1 }]}>{videoInputNote(config, probe)}</Text>
        {probe.running ? <ActivityIndicator size="small" color={color.cyan} /> : <SmallButton label="重新测" onPress={service.retest} />}
      </View> : null}
  </Panel>;
}

// onRetry：只有素材库里还有这条视频才能重新解析（旧版迁过来的条目没有）；onOpen：有原视频地址才能在浏览器里打开
function Detail({ item, busy, onRetry, onRemove, onOpen }: { item: VideoAnalysis; busy: boolean; onRetry?: () => void; onRemove: () => void; onOpen?: () => void }) {
  const [copied, setCopied] = useState(false);
  const video = item.video;
  const facts = [
    video?.author,
    video?.durationSeconds ? `${video.durationSeconds} 秒` : null,
    video?.publishedAt ? `${new Date(video.publishedAt).toLocaleDateString("zh-CN")} 发布` : null,
    `${new Date(item.updatedAt).toLocaleString("zh-CN", { hour12: false })} 解析`,
  ].filter(Boolean).join(" · ");
  const copy = () => {
    if (!item.markdown || Platform.OS !== "web") return;
    void navigator.clipboard?.writeText(item.markdown).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); });
  };
  return <View {...ws("e-box", "an-detail")} style={styles.detail}>
    <Text style={styles.detailTitle}>{video?.title || "没有标题的视频"}</Text>
    <Text style={kit.muted}>{facts}</Text>
    {video?.tags?.length ? <Text style={kit.muted}>{video.tags.map((tag) => `#${tag}`).join("  ")}</Text> : null}
    <View style={kit.row}>
      {onOpen ? <SmallButton label="打开原视频" onPress={onOpen}><ArrowUpRight size={14} color={color.text} /></SmallButton> : null}
      {item.markdown ? <SmallButton label={copied ? "已复制" : "复制全文"} done={copied} onPress={copy}><Copy size={14} color={color.text} /></SmallButton> : null}
      {onRetry ? <SmallButton label="重新解析" disabled={busy || item.status === "running"} onPress={onRetry}><RefreshCw size={14} color={color.text} /></SmallButton> : null}
      <SmallButton label="删除" disabled={item.status === "running"} onPress={onRemove}><Trash2 size={14} color={color.text} /></SmallButton>
    </View>
    {item.status === "running" ? <View style={kit.row}><ActivityIndicator color={color.cyan} /><Text style={kit.body}>{stageText(item)}{item.stage === "looking" ? "这一步要开着应用（切到别的页面没关系），拆完再交给 AI。" : item.stage === "squeezing" ? "这一步要开着应用（切到别的页面没关系），压完再交给 AI。" : "一条一般要几分钟，视频越长越久，可以先去看别的。"}</Text></View> : null}
    {item.error ? <ErrorLine text={item.markdown ? `${item.error}下面是上一次的结果。` : item.error} /> : null}
    {item.markdown ? <Markdown text={item.markdown} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvas },
  probeRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: color.borderSoft },
  content: { padding: 32, gap: 18, paddingBottom: 70 },
  contentNarrow: { padding: 16 },
  gate: { alignItems: "center", gap: 14, paddingVertical: 60 },
  gateTitle: { color: color.text, fontFamily: font.body, fontSize: 17, fontWeight: "600" },
  bar: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface, flexWrap: "wrap" },
  barHint: { flex: 1, minWidth: 160 },
  handoff: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderWidth: 1, borderColor: color.accent, borderRadius: radius.medium, backgroundColor: alpha(color.accent, 0.04) },
  dropMask: { position: "absolute", top: 12, left: 12, right: 12, bottom: 12, alignItems: "center", justifyContent: "center", borderWidth: 2, borderStyle: "dashed", borderColor: color.accent, borderRadius: radius.medium, backgroundColor: alpha(color.surface, 0.92) },
  dropText: { color: color.text, fontFamily: font.body, fontSize: 14 },
  input: { flex: 1, minWidth: 220, minHeight: 38, paddingHorizontal: 12, color: color.text, fontFamily: font.body, fontSize: 14, borderRadius: radius.small, backgroundColor: color.surfaceRaised },
  search: { flex: 0, minWidth: 0 },
  field: { gap: 6 },
  label: { color: color.textSecondary, fontFamily: font.body, fontSize: 12 },
  fieldInput: { flex: 0, minWidth: 0 },
  multiline: { minHeight: 70, paddingVertical: 10, textAlignVertical: "top" },
  columns: { flexDirection: "row", gap: 18, alignItems: "flex-start" },
  columnsNarrow: { flexDirection: "column", alignItems: "stretch" },
  list: { width: 300, gap: 8 },
  listNarrow: { width: "100%" },
  item: { gap: 6, padding: 12, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small, backgroundColor: color.surface },
  itemOn: { borderColor: color.accent, backgroundColor: alpha(color.accent, 0.08) },
  itemTitle: { color: color.text, fontFamily: font.body, fontSize: 13, lineHeight: 20, fontWeight: "600" },
  detail: { flex: 1, minWidth: 0, alignSelf: "stretch", gap: 12, padding: 22, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface },
  detailTitle: { color: color.text, fontFamily: font.body, fontSize: 18, lineHeight: 27, fontWeight: "600" },
});
