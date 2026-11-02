import { requestAnalysis, AnalysisError } from '../videoAnalysis.mjs';
import { modelFetch } from '../systemProxy.mjs';
import { isLocalRuntime, runtimeLabel } from '../localAi.mjs';
import { seesNoImages, seesNoVideo, videoRefused } from './look.mjs';
import { priceVisionCall } from './visionUsage.mjs';

// 一次任务共用路由状态；不会改用户配置，也不会反复回到本轮已失败的服务。
// 未经同模型对照证明视频更好时，自动路线以图片为默认。
export const DEFAULT_VISUAL_INPUT = 'images';
const identity = c => JSON.stringify([c?.runtime || 'api', c?.baseUrl || '', c?.model || '', c?.apiKey || '']);
const label = c => isLocalRuntime(c.runtime) ? runtimeLabel(c.runtime, c.model) : c.model;
const unavailable = (message, code = 'images_unsupported') => new AnalysisError(code, message, 422);
const imageRefused = e => e.code === 'images_unsupported' || ([400, 415, 422, 0, 200].includes(e.providerStatus)
  && /image|vision|图片|图像/iu.test(e.message) && /support|unsupported|not.*allow|不支持|无法|不接受/iu.test(e.message));
const videoRejected = e => e.code === 'video_unsupported' || e.providerStatus === 413
  || videoRefused(e.providerStatus, e.message, { strict: true });

export function createVisionRouter(ctx) {
  const candidates = [ctx.analysis && { role: '解析模型', config: ctx.analysis }, ctx.config && { role: '剪辑模型', config: ctx.config }]
    .filter(Boolean).filter((x, i, all) => all.findIndex(y => identity(y.config) === identity(x.config)) === i)
    .map(x => ({ ...x, failed: false, images: x.config.imageInput ?? null, video: isLocalRuntime(x.config.runtime) ? false : x.config.videoInput ?? null }));
  const calls = [], events = [];
  let current = 0, last = null, startupReported = false;
  const announce = message => { events.push(message); ctx.onGenerating?.(message); };
  const snapshot = () => ({ calls: structuredClone(calls), events: [...events],
    capabilities: candidates.map(c => ({ role: c.role, model: label(c.config), images: c.images, video: c.video })) });
  async function ask({ parts, videos, videoBase64, videoFps, prompt, video, inputMode = 'images', signal, timeoutMs = 10 * 60_000 }) {
    const strictVideo = Array.isArray(videos);
    const combined = AbortSignal.any([ctx.signal, signal].filter(Boolean));
    combined.throwIfAborted();
    if (ctx.analysisIssue && !startupReported) {
      startupReported = true;
      announce(`解析模型配置不可用（${ctx.analysisIssue}），本轮视觉分析改用剪辑模型，消耗归剪辑模型。`);
    }
    const getParts = async () => typeof parts === 'function' ? parts() : parts;
    // 不支持视频的模型仍可能支持图片；只跳过当前输入类型和本轮真正失败的服务。
    current = 0;
    while (current < candidates.length) {
      combined.throwIfAborted();
      const candidate = candidates[current], config = candidate.config;
      if (candidate.failed || (strictVideo ? candidate.video === false || isLocalRuntime(candidate.config.runtime) : candidate.images === false)) { current++; continue; }
      let mode = strictVideo || ((inputMode === 'video' || (inputMode === 'auto' && DEFAULT_VISUAL_INPUT === 'video'))
        && candidate.video !== false && videoBase64) ? 'video' : 'images';
      for (;;) {
        combined.throwIfAborted();
        // 本地解码错误不是模型故障；不能换个模型掩盖缺失的视觉材料。
        const input = mode === 'images' ? await getParts() : undefined;
        if (mode === 'images' && !input?.some(p => p.type === 'image_url')) throw unavailable('没有可用于视觉分析的图片，未调用模型。', 'look_unavailable');
        combined.throwIfAborted();
        const call = { role: candidate.role, runtime: config.runtime || 'api', model: label(config), requestedModel: config.model || null, input: mode,
          imageCount: input?.filter(p => p.type === 'image_url').length ?? 0, attempts: [], startedAt: new Date().toISOString() };
        if (strictVideo) call.videoCount = videos.filter(p => p.type === 'video_url').length;
        calls.push(call); const started = Date.now();
        const fetchImpl = async (url, init) => {
          combined.throwIfAborted();
          const attempt = { number: call.attempts.length + 1 }; call.attempts.push(attempt);
          try { const response = await (ctx.fetchImpl ?? modelFetch)(url, init); attempt.status = response.status; return response; }
          catch (e) { attempt.error = e.name; throw e; }
        };
        try {
          const text = await requestAnalysis({ config, parts: strictVideo ? videos : input, videoBase64: mode === 'video' ? videoBase64 : undefined,
            videoFps, prompt: typeof prompt === 'function' ? prompt(mode) : prompt, video, signal: AbortSignal.any([combined, AbortSignal.timeout(timeoutMs)]),
            fetchImpl, localAi: ctx.localAi, reasoningEffort: 'low', onUsage: usage => {
              call.usage = usage;
              const attempt = call.attempts.at(-1); if (attempt) attempt.usage = usage;
            }, onModel: name => {
              if (typeof name === 'string' && name.trim()) call.model = isLocalRuntime(config.runtime) ? runtimeLabel(config.runtime, name.slice(0, 160)) : name.slice(0, 160);
            } });
          combined.throwIfAborted();
          if (mode === 'video' && (seesNoVideo(text) || seesNoImages(text))) throw unavailable('模型没有读取到视频画面', 'video_unsupported');
          if (mode === 'images' && seesNoImages(text)) throw unavailable('模型没有读取到图片');
          candidate[mode === 'video' ? 'video' : 'images'] = true;
          call.status = 'success'; last = { role: candidate.role, model: call.model, input: mode };
          return text;
        } catch (error) {
          call.status = combined.aborted ? 'cancelled' : 'failed'; call.error = error.code ?? error.name;
          if (combined.aborted) throw combined.reason;
          if (['interrupted', 'local_closed', 'look_unavailable', 'look_failed'].includes(error.code) || error.name === 'AbortError') throw error;
          if (strictVideo) {
            if (videoRejected(error)) { if (error.providerStatus !== 413) candidate.video = false; }
            else candidate.failed = true;
            current++;
            if (current >= candidates.length) throw unavailable(`视频复核未完成：${error.message}。不会以截图检查代替运动验收。`, 'video_unavailable');
            announce('当前模型未完成视频复核，尝试下一个支持视频的模型。');
            break;
          }
          if (mode === 'video' && videoRejected(error)) {
            if (error.providerStatus !== 413) candidate.video = false;
            announce(`${candidate.role} ${label(config)} 无法读取本次视频，改用连续帧图片。`);
            mode = 'images'; continue;
          }
          if (mode === 'images' && imageRefused(error)) candidate.images = false;
          candidate.failed = true;
          const next = candidates.slice(current + 1).find(c => !c.failed && c.images !== false);
          const reason = error.code === 'provider_error' ? `接口错误 ${error.providerStatus ?? ''}` : (error.code ?? error.name);
          if (next) announce(`${candidate.role} ${label(config)} 本轮不可用（${reason}），自动改用${next.role} ${label(next.config)}，后续消耗归该模型。`);
          else throw unavailable(`没有可用的视觉模型。${candidate.role} ${label(config)}：${error.message}`, 'vision_unavailable');
          current++; inputMode = 'images'; break;
        } finally {
          call.elapsedMs = Date.now() - started;
          priceVisionCall(call, config);
          await ctx.onVisionCall?.(structuredClone(call));
        }
      }
    }
    throw unavailable(strictVideo ? '没有支持视频的可用模型，运动未验证；请配置视频解析模型。' : '没有可用的视觉模型，请确保剪辑模型或解析模型中至少一个能看图片。', strictVideo ? 'video_unavailable' : 'vision_unavailable');
  }
  return { ask, snapshot, rejectCurrent(reason) {
    const old = candidates[current], next = candidates.slice(current + 1).find(c => !c.failed && c.images !== false);
    if (!old || !next) return false;
    old.failed = true; current++;
    announce(`${old.role} ${label(old.config)} 的分析未通过校验（${reason}），改用${next.role} ${label(next.config)}。`);
    return true;
  }, get last() { return last; }, note: () => {
    const used = [...new Set(calls.map(c => `${c.role} ${c.model}（${c.input === 'video' ? '视频' : '图片'}）`))];
    return [...events, ...(used.length ? [`本轮视觉调用：${used.join('、')}；共 ${calls.length} 次，消耗对应模型的额度。`] : [])].join('\n');
  } };
}

export function visionFor(ctx) { return ctx.vision ??= createVisionRouter(ctx); }
