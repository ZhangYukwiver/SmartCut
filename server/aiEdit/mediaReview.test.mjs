import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { inspectImage, previewPage, reviewVideoFrames } from './mediaReview.mjs';
import { TOOL_CONTENT } from './toolContent.mjs';

const crop = [0, .36, 1, .28];
function fixture() {
  const requests = [], analyses = [];
  const items = { render: { id: 'render', name: '渲染', kind: 'video', durationUs: 10_200_000 },
    reference: { id: 'reference', name: '原片', kind: 'video', durationUs: 25_783_333 } };
  const ctx = { library: { readyPath: id => { if (!items[id]) throw new Error('missing'); }, get: id => items[id], list: () => Object.values(items) },
    askLook: async request => { requests.push(request); return { assets: request.crops.map((_, i) => `data:image/jpeg;base64,${Buffer.from(request.url + i).toString('base64')}`) }; },
    vision: { ask: async request => { analyses.push(request); return '明显不符：顶部不应封闭。'; }, snapshot: () => ({ calls: [] }) } };
  return { ctx, requests, analyses };
}

describe('review rendered video frames', () => {
  it('shows real image bytes for texture selection, without storing image payloads in history', async () => {
    const { ctx, analyses } = fixture();
    ctx.library = { readyPath: () => fileURLToPath(new URL('../fixtures/ai-edit/media/still.png', import.meta.url)), get: () => ({ kind: 'image', name: '原始取景', source: { type: 'reference-frame', time: 2.65 } }) };
    const result = await inspectImage(ctx, { media_id: 'image', instructions: '定位字幕边缘' });
    expect(analyses[0].parts[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/u);
    expect(result.source).toMatchObject({ time: 2.65 });
    expect(JSON.stringify(result)).not.toContain('base64');
    expect(result[TOOL_CONTENT][1].data.length).toBeGreaterThan(100);
    ctx.library.get = () => ({ kind: 'video' });
    await expect(inspectImage(ctx, { media_id: 'video' })).rejects.toMatchObject({ code: 'arguments_invalid' });
    expect(analyses).toHaveLength(1);
  });

  it('previews actual page times without materializing a temporary video and returns only a checked candidate', async () => {
    const { ctx, requests, analyses } = fixture();
    const previews = [];
    ctx.pages = { preview: async args => {
      previews.push(args);
      return { images: ['data:image/jpeg;base64,YQ=='], preview_id: 'candidate', duration: 10.2, problems: [], diagnostics: [{ time: 4.2, nearly_black: false, unstable: false, repeat_difference: 0 }],
        baseline: { images: ['data:image/jpeg;base64,Yg=='], problems: [], diagnostics: [{ time: 4.2, unstable: false }] } };
    } };
    const html = '<script>window.film={duration:10.2,frame(t){}}</script>';
    const result = await previewPage(ctx, { html, page_id: 'page', times: [4.2], crop, reference_media_id: 'reference', reference_offset: 2.8 });
    expect(previews[0]).toEqual({ html, page_id: 'page', times: [4.2], crop, reference: { media_id: 'reference', offset: 2.8, crop, reference_crop: crop } });
    expect(requests).toHaveLength(1);
    expect(requests[0].crops).toEqual([{ time: 7, crop }]);
    expect(analyses[0].parts[0].text).toContain('REFERENCE 原片 7');
    expect(analyses[0].parts[2].text).toContain('BASELINE 修改前正式版 4.2');
    expect(analyses[0].parts[3].image_url.url).toBe('data:image/jpeg;base64,Yg==');
    expect(analyses[0].parts[4].text).toContain('RENDER 实际渲染素材 4.2');
    expect(analyses[0].parts[5].image_url.url).toBe('data:image/jpeg;base64,YQ==');
    expect(analyses[0].prompt).toContain('仍有差距不等于本次没有改善');
    expect(analyses[0].prompt).toContain('加载/脚本问题列表：[]');
    expect(analyses[0].prompt).toContain('unstable=false 表示该采样时刻重画检查通过');
    expect(result).toMatchObject({ preview_id: 'candidate', duration: 10.2, samples: [{ time: 4.2, reference_time: 7 }] });
    expect(JSON.stringify(result)).not.toContain('base64');
    expect(result.baseline.kind).toBe('formal-page');
    expect(result[TOOL_CONTENT].filter(part => part.type === 'image')).toHaveLength(3);
    ctx.vision.ask = async () => { throw new Error('vision failed'); };
    await expect(previewPage(ctx, { html, times: [4.2] })).rejects.toThrow('vision failed');
  });

  it('states when a longer candidate has no same-time baseline instead of inventing a comparison', async () => {
    const { ctx, analyses } = fixture();
    const note = '采样包含原正式版时长以外的时刻';
    ctx.pages = { preview: async () => ({ images: ['data:image/jpeg;base64,YQ=='], preview_id: 'longer', duration: 12, problems: [], diagnostics: [], baseline_note: note }) };
    const result = await previewPage(ctx, { html: '<script>window.film={duration:12}</script>', times: [11] });
    expect(analyses[0].parts).toHaveLength(2);
    expect(analyses[0].prompt).toContain(note);
    expect(result.baseline_note).toBe(note);
    expect(result.baseline).toBeUndefined();
  });

  it('checks a transparent page locally without paying to judge a black-flattened mask', async () => {
    const { ctx, requests, analyses } = fixture();
    ctx.library.list = () => [{ source: { pageId: 'mask', transparent: true } }];
    ctx.pages = { preview: async () => ({ images: ['data:image/jpeg;base64,YQ=='], preview_id: 'overlay', duration: 2.2, problems: [], diagnostics: [{ time: 1, nearly_black: true, unstable: false }] }) };
    const result = await previewPage(ctx, { page_id: 'mask', times: [1], reference_media_id: 'reference' });
    expect(result.preview_id).toBe('overlay'); expect(result.note).toContain('本次不请求静帧视觉评审');
    expect(requests).toHaveLength(0); expect(analyses).toHaveLength(0);
  });

  it('compares exact time pairs in reference/render order, retaining crop and fresh renders', async () => {
    const { ctx, requests, analyses } = fixture();
    const args = { media_id: 'render', times: [1, 4, 9], crop, reference_media_id: 'reference', reference_offset: 2.8 };
    const result = await reviewVideoFrames(ctx, args);
    expect(requests.map(r => r.crops)).toEqual([
      [1, 4, 9].map(time => ({ time, crop })), [3.8, 6.8, 11.8].map(time => ({ time, crop })),
    ]);
    const labels = analyses[0].parts.filter(p => p.type === 'text').map(p => p.text);
    expect(labels[0]).toContain('REFERENCE 原片 3.8');
    expect(labels[1]).toContain('RENDER 实际渲染素材 1');
    expect(analyses[0].parts.filter(p => p.type === 'image_url')).toHaveLength(6);
    expect(result.review).toContain('顶部不应封闭');
    expect(JSON.stringify(result)).not.toContain('base64');
    expect({ ...result }[TOOL_CONTENT].filter(p => p.type === 'image')).toHaveLength(6);
    await reviewVideoFrames(ctx, args);
    expect(requests).toHaveLength(4);
  });

  it('rejects out-of-range pairs and invalid crops before decoding or invoking vision', async () => {
    const { ctx, requests, analyses } = fixture();
    for (const args of [
      { times: [1, 1] }, { times: [10.2] }, { times: [1], reference_media_id: 'reference', reference_offset: -2 },
      { times: [1], crop: [.5, 0, .6, 1] }, { times: [1], reference_offset: Infinity },
    ]) await expect(reviewVideoFrames(ctx, { media_id: 'render', ...args })).rejects.toMatchObject({ code: 'arguments_invalid' });
    expect(requests).toHaveLength(0); expect(analyses).toHaveLength(0);
  });

  it('does not give a visual verdict for missing frames or an interrupted read', async () => {
    const { ctx, analyses } = fixture();
    ctx.askLook = async () => ({ assets: [] });
    await expect(reviewVideoFrames(ctx, { media_id: 'render', times: [1] })).rejects.toMatchObject({ code: 'look_failed' });
    const controller = new AbortController(); ctx.signal = controller.signal;
    ctx.askLook = async () => { controller.abort(); return { assets: ['data:image/jpeg;base64,YQ=='] }; };
    await expect(reviewVideoFrames(ctx, { media_id: 'render', times: [1] })).rejects.toMatchObject({ name: 'AbortError' });
    expect(analyses).toHaveLength(0);
  });
});
