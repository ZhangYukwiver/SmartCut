import { afterEach, expect, it } from 'vitest';
import { chromeProvider, findBrowser, openTab } from './browser.mjs';
import { TEXT_AUDIT_SCRIPT, TEXT_AUDIT_READ, summarizeTextBounds } from './textBounds.mjs';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { createFilmFiles } from './serve.mjs';
import { createReviewClips } from './reviewClips.mjs';

const providers = [];
afterEach(async () => { await Promise.all(providers.splice(0).map(p => p.close())); }, 30_000);

it.skipIf(!findBrowser())('catches one-frame canvas overflow between video samples, clears resize history and excludes invisible DOM text', async () => {
  const provider = chromeProvider(); providers.push(provider);
  const html = `<style>body{margin:0}.hidden{display:none}</style><span class="hidden" style="position:absolute;left:900px">hidden</span><canvas id="c"></canvas><script>
  const c=document.querySelector('canvas'),g=c.getContext('2d');window.film={duration:1,frame(t){c.width=320;c.height=180;g.font='24px Arial';g.textBaseline='top';g.fillText('VISIBLE',Math.round(t*30)===17?310:40,50)}};</script>`;
  const tab = await openTab(provider, `data:text/html,${encodeURIComponent(html)}`, { width: 320, height: 180, initScript: TEXT_AUDIT_SCRIPT });
  try {
    const frames = [];
    for (let i = 0; i < 30; i++) { await tab.seek(i / 30); frames.push({ time: i / 30, ...await tab.evaluate(TEXT_AUDIT_READ) }); }
    const result = summarizeTextBounds(frames, { width: 320, height: 180, fps: 30, start: 0, duration: 1 });
    expect(result).toMatchObject({ status: 'fail', checked_frames: 30, frames_with_text: 30, violating_frames: 1 });
    expect(result.first_violation.time).toBe(17 / 30);
    expect(result.max_overflow_px).toBeGreaterThan(50);
    expect(frames[18].boxes).toHaveLength(1);
    expect(result.violations[0].text).toBe('VISIBLE');
  } finally { await tab.close(); }
}, 30_000);

it.skipIf(!findBrowser())('propagates lyric scope from marked DOM and canvas regions while leaving a title unmarked', async () => {
  const provider = chromeProvider(); providers.push(provider);
  const html = `<style>body{margin:0}span{display:block;font:24px Arial}</style><span>STATIC TITLE</span><div data-smartcut-lyrics><span>DOM LYRIC</span></div><canvas data-smartcut-lyrics id="source" width="320" height="180" style="display:none"></canvas><canvas id="c" width="320" height="180"></canvas><script>
  const source=document.querySelector('#source'),sg=source.getContext('2d'),c=document.querySelector('#c'),g=c.getContext('2d');window.film={duration:1,frame(){sg.clearRect(0,0,320,180);sg.font='24px Arial';sg.fillStyle='white';sg.fillText('CANVAS LYRIC',10,60);g.clearRect(0,0,320,180);g.drawImage(source,0,0)}};</script>`;
  const tab = await openTab(provider, `data:text/html,${encodeURIComponent(html)}`, { width: 320, height: 180, initScript: TEXT_AUDIT_SCRIPT });
  try {
    await tab.seek(0); const result = await tab.evaluate(TEXT_AUDIT_READ);
    expect(result.boxes.find(box => box.text === 'STATIC TITLE')?.lyric_scope).toBe(false);
    expect(result.boxes.filter(box => box.lyric_scope).map(box => box.text)).toEqual(expect.arrayContaining(['DOM LYRIC', 'CANVAS LYRIC']));
  } finally { await tab.close(); }
}, 15_000);

it('never treats absent measurements or incomplete coverage as a passed boundary audit', () => {
  const meta = { width: 320, height: 180, fps: 30, start: 0, duration: 1 };
  expect(summarizeTextBounds([{ time: 0, boxes: [] }], meta).status).toBe('uncertain');
  expect(summarizeTextBounds([{ time: 0, boxes: [{ left: 0, right: 100, top: 0, bottom: 20 }], limitations: ['WebGL'] }], meta).status).toBe('uncertain');
  const frame = { time: 0, boxes: [{ left: 0, right: 100, top: 0, bottom: 20 }] };
  expect(summarizeTextBounds([frame], meta)).toMatchObject({ status: 'uncertain', expected_frames: 30, missing_frames: 29 });
  expect(summarizeTextBounds(Array(30).fill(frame), meta)).toMatchObject({ status: 'uncertain', missing_frames: 29, duplicate_frames: 29 });
  const complete = Array.from({ length: 30 }, (_, i) => ({ ...frame, time: i / 30 }));
  expect(summarizeTextBounds(complete, meta).status).toBe('pass');
  complete[10] = { ...frame, time: .345 };
  expect(summarizeTextBounds(complete, meta)).toMatchObject({ status: 'uncertain', missing_frames: 1, invalid_frames: 1 });
});

it.skipIf(!findBrowser())('detects inset CSS clipping and reports complex DOM masks as uncovered', async () => {
  const provider = chromeProvider(); providers.push(provider);
  const html = `<style>body{margin:0}span{position:absolute;left:30px;top:30px;font:bold 40px Arial}</style><span>CROPPED</span><script>
  window.film={duration:4,frame(t){const s=document.querySelector('span').style;s.clipPath=t<1?'inset(0 50% 0 0)':t<2?'inset(0)':t<3?'circle(20% at 50% 50%)':'none';s.maskImage=t>=3?'linear-gradient(black,transparent)':'none'}};</script>`;
  const tab = await openTab(provider, `data:text/html,${encodeURIComponent(html)}`, { width: 320, height: 180, initScript: TEXT_AUDIT_SCRIPT });
  try {
    await tab.seek(0); const cut = await tab.evaluate(TEXT_AUDIT_READ); expect(cut.boxes[0].clipped).toBe(true);
    await tab.seek(1); const clear = await tab.evaluate(TEXT_AUDIT_READ); expect(clear.boxes[0].clipped).toBe(false); expect(clear.limitations).toEqual([]);
    await tab.seek(2); expect((await tab.evaluate(TEXT_AUDIT_READ)).limitations.join(' ')).toContain('clip-path');
    await tab.seek(3); expect((await tab.evaluate(TEXT_AUDIT_READ)).limitations.join(' ')).toContain('CSS mask');
  } finally { await tab.close(); }
}, 30000);

it.skipIf(!findBrowser())('unions both triangle pieces of curved text and catches a hole inside its outer rectangle', async () => {
  const provider=chromeProvider();providers.push(provider);
  const html=`<style>body{margin:0}</style><canvas id="c" width="320" height="180"></canvas><script>
  const c=document.querySelector('canvas'),g=c.getContext('2d'),tex=document.createElement('canvas');tex.width=240;tex.height=80;const q=tex.getContext('2d');
  window.film={duration:1,frame(t){c.width=320;q.clearRect(0,0,240,80);q.font='bold 48px Arial';q.fillStyle='#00ccff';q.fillText('GLYPHS',12,60);
  for(let k=0;k<2;k++){g.save();g.beginPath();if(k===0){g.moveTo(20,20);g.lineTo(260,20);g.lineTo(20,100)}else{g.moveTo(260,20);g.lineTo(260,100);g.lineTo(20,100)}g.closePath();g.clip();
  if(Math.round(t*30)===17){g.beginPath();g.rect(0,0,320,180);g.rect(55,20,22,80);g.clip('evenodd');}g.drawImage(tex,20,20);g.restore();}}};</script>`;
  const tab=await openTab(provider,`data:text/html,${encodeURIComponent(html)}`,{width:320,height:180,initScript:TEXT_AUDIT_SCRIPT});
  try{
    await tab.seek(0);const good=await tab.evaluate(TEXT_AUDIT_READ);
    expect(good.limitations).toEqual([]);expect(good.boxes).toHaveLength(1);expect(good.boxes[0].glyph_coverage).toBeGreaterThan(.995);expect(good.boxes[0].clipped).toBe(false);
    await tab.seek(17/30);const cut=await tab.evaluate(TEXT_AUDIT_READ);
    expect(cut.boxes[0].glyph_coverage).toBeLessThan(.93);expect(cut.boxes[0].clipped).toBe(true);
    const summary=summarizeTextBounds([{time:0,...good},{time:17/30,...cut}],{width:320,height:180,fps:30,start:0,duration:1});
    expect(summary.violating_frames).toBe(1);expect(summary.max_overflow_px).toBe(0);
  }finally{await tab.close();}
},30000);

it.skipIf(!findBrowser())('inspects every frame inside the actual timeline iframe and returns the underlying image in screenshots', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'composite-audit-'))), pageId = 'b'.repeat(16);
  const provider = chromeProvider(); providers.push(provider);
  const files = createFilmFiles({ root });
  const server = createServer(async (req, res) => { if (!await files.handle(req, res, new URL(req.url, 'http://localhost'))) res.writeHead(404).end(); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    await mkdir(path.join(root, 'pages', pageId), { recursive: true }); await mkdir(path.join(root, 'media'));
    const base = path.join(root, 'media', 'c'.repeat(32) + '.png'), overlay = path.join(root, 'media', 'd'.repeat(32) + '.mov');
    await sharp({ create: { width: 320, height: 180, channels: 3, background: '#2244ee' } }).png().toFile(base);
    const html = `<style>body{margin:0;background:transparent}</style><canvas id="c"></canvas><script>const c=document.querySelector('canvas'),g=c.getContext('2d');window.film={duration:1,frame(t){c.width=320;c.height=180;g.font='24px Arial';g.fillStyle='white';g.fillText('TEST',Math.round(t*30)===7?310:30,60)}};</script>`;
    await writeFile(path.join(root, 'pages', pageId, 'index.html'), html);
    const items = { base: { id: 'base', kind: 'image', width: 320, height: 180 }, overlay: { id: 'overlay', kind: 'video', width: 320, height: 180, source: { type: 'page', pageId, page: `${pageId}/index.html`, transparent: true } } };
    const library = { idForPath: p => p === base ? 'base' : 'overlay', get: id => items[id], readyPath: id => id === 'base' ? base : overlay };
    const project = { canvas: { width: 320, height: 180, fps: 30 }, tracks: [base, overlay].map((file, i) => ({ track_type: 'video', segments: [{ id: `clip${i}`, kind: i ? 'video' : 'image', path: file, timeline: { start_us: 0, duration_us: 1e6 }, source: { start_us: 0, duration_us: 1e6 } }] })) };
    const clips = createReviewClips({ root, library, files, provider, getOrigin: () => `http://127.0.0.1:${server.address().port}` });
    const result = await clips.inspect({ sessionId: 'a'.repeat(32), pageId, html, project, ...project.canvas, start: 0, duration: 1, times: [.2, 7 / 30], audit: true });
    expect(result.boundaries).toMatchObject({ checked_frames: 30, violating_frames: 1, status: 'fail' });
    expect(result.boundaries.first_violation.time).toBe(7 / 30);
    const pixel = await sharp(Buffer.from(result.images[0].url.split(',')[1], 'base64')).extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer();
    expect(pixel[2]).toBeGreaterThan(220); expect(pixel[0]).toBeLessThan(45);
    expect((await clips.readFrames(result.images)).length).toBe(2);
  } finally {
    await provider.close(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
