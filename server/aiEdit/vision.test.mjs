import { describe, expect, it } from 'vitest';
import { createVisionRouter } from './vision.mjs';
const config = { baseUrl: 'https://edit.example/v1', apiKey: 'secret', model: 'edit' };
const analysis = { ...config, baseUrl: 'https://analysis.example/v1', model: 'analysis' };
const parts = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }];
const answer = text => Response.json({ choices: [{ message: { content: text } }], usage: { total_tokens: 12 } });
const request = { parts, prompt: '只看实际图片', videoBase64: 'AAAA', inputMode: 'video' };
describe('visual model routing', () => {
  it('keeps motion review video-only and never downgrades a refused video to images or a local CLI', async () => {
    const sent = [], calls = [];
    const router = createVisionRouter({ analysis, config: { runtime: 'codex', model: 'local' }, onVisionCall: call => calls.push(call),
      fetchImpl: async (_, init) => { sent.push(JSON.parse(init.body)); return new Response('unsupported video input', { status: 415 }); } });
    await expect(router.ask({ videos: [{ type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' }, fps: 10 }], prompt: 'motion' })).rejects.toMatchObject({ code: 'video_unavailable' });
    expect(sent).toHaveLength(1); expect(sent[0].messages[0].content.some(p => p.type === 'image_url')).toBe(false);
    expect(calls[0]).toMatchObject({ input: 'video', videoCount: 1, status: 'failed' });
  });
  it('uses the editing model when analysis is absent and defaults to images', async () => {
    const sent=[]; const router=createVisionRouter({config,fetchImpl:async(_,init)=>{sent.push(JSON.parse(init.body));return answer('seen');}});
    expect(await router.ask({...request,inputMode:'auto'})).toBe('seen');
    expect(sent[0].messages[0].content[0].type).toBe('image_url');
    expect(router.snapshot().calls[0]).toMatchObject({role:'剪辑模型',usage:{total_tokens:12},status:'success'});
    expect(JSON.stringify(router.snapshot())).not.toContain('secret');
  });
  it('can still inspect images after strict video refusal without retrying that video capability', async () => {
    const sent = [];
    const router = createVisionRouter({ analysis, config: { runtime: 'codex', model: 'local' },
      fetchImpl: async (_, init) => {
        const body = JSON.parse(init.body); sent.push(body);
        return body.messages[0].content.some(p => p.type === 'video_url') ? new Response('unsupported video input', { status: 415 }) : answer('seen');
      } });
    const motion = { videos: [{ type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } }], prompt: 'motion' };
    await expect(router.ask(motion)).rejects.toMatchObject({ code: 'video_unavailable' });
    expect(await router.ask({ parts, prompt: 'layout' })).toBe('seen');
    await expect(router.ask(motion)).rejects.toMatchObject({ code: 'video_unavailable' });
    expect(sent.map(b => b.messages[0].content[0].type)).toEqual(['video_url', 'image_url']);
  });
  it('never sends video when the configured analysis model is image only', async () => {
    const sent=[]; const router=createVisionRouter({config,analysis:{...analysis,videoInput:false},fetchImpl:async(_,init)=>{sent.push(JSON.parse(init.body));return answer('seen');}});
    await router.ask(request);
    expect(sent.map(x=>x.messages[0].content[0].type)).toEqual(['image_url']);
  });
  it('falls back to images on the same model after video refusal', async () => {
    const sent=[]; const router=createVisionRouter({config,analysis,fetchImpl:async(_,init)=>{const b=JSON.parse(init.body);sent.push(b);return b.messages[0].content[0].type==='video_url'?new Response('unsupported video input',{status:415}):answer('seen');}});
    await router.ask(request); await router.ask(request);
    expect(sent.map(x=>x.messages[0].content[0].type)).toEqual(['video_url','image_url','image_url']);
    expect(router.snapshot().capabilities[0]).toMatchObject({video:false,images:true});
  });
  it('does not retry bad credentials using images and stays on the working editing model', async () => {
    const sent=[];const router=createVisionRouter({config,analysis,fetchImpl:async(_,init)=>{const b=JSON.parse(init.body);sent.push(b);return b.model==='analysis'?new Response('bad key',{status:401}):answer('seen');}});
    await router.ask(request);await router.ask({...request,inputMode:'images'});
    expect(sent.map(x=>[x.model,x.messages[0].content[0].type])).toEqual([['analysis','video_url'],['edit','image_url'],['edit','image_url']]);
    expect(router.snapshot().capabilities[0].video).toBeNull();
    expect(router.note()).toContain('自动改用剪辑模型');
  });
  it('fails explicitly when neither model can see images without inventing a plan', async () => {
    const router=createVisionRouter({config,analysis,fetchImpl:async()=>answer('NO_IMAGES')});
    await expect(router.ask({...request,inputMode:'images'})).rejects.toMatchObject({code:'vision_unavailable'});
    expect(router.snapshot().calls).toHaveLength(2);
  });
  it('cancels without calling a fallback or changing saved configuration', async () => {
    const c=new AbortController(),sent=[];const router=createVisionRouter({config,analysis,signal:c.signal,fetchImpl:async(_,init)=>{sent.push(JSON.parse(init.body).model);c.abort();return answer('seen');}});
    await expect(router.ask(request)).rejects.toMatchObject({name:'AbortError'});
    expect(sent).toEqual(['analysis']); expect(analysis.videoInput).toBeUndefined();
  });
  it('does not mistake an unreadable local video for a model failure', async () => {
    let calls=0;const router=createVisionRouter({config,analysis,fetchImpl:async()=>{calls++;return answer('seen');}});
    await expect(router.ask({parts:async()=>{throw new Error('decoder failed');},prompt:'x'})).rejects.toThrow('decoder failed');
    expect(calls).toBe(0);
  });
  it('keeps capabilities unknown after a network failure and switches only once', async () => {
    const sent=[];const router=createVisionRouter({config,analysis,fetchImpl:async(_,init)=>{const b=JSON.parse(init.body);sent.push(b.model);if(b.model==='analysis')throw new TypeError('network disconnected');return answer('seen');}});
    await router.ask(request);await router.ask(request);
    expect(sent).toEqual(['analysis','edit','edit']);
    expect(router.snapshot().capabilities[0]).toMatchObject({images:null,video:null});
  });
  it('does not retry an exhausted service in another format', async () => {
    const sent=[];const router=createVisionRouter({config,analysis,fetchImpl:async(_,init)=>{const b=JSON.parse(init.body);sent.push(b.model);return b.model==='analysis'?new Response('quota exhausted',{status:429}):answer('seen');}});
    await router.ask(request);
    expect(sent).toEqual(['analysis','edit']);
    expect(router.snapshot().calls[1].input).toBe('images');
  });
  it('makes no request when both configured models are known not to see images', async () => {
    let calls=0;const router=createVisionRouter({config:{...config,imageInput:false},analysis:{...analysis,imageInput:false},fetchImpl:async()=>{calls++;return answer('seen');}});
    await expect(router.ask(request)).rejects.toMatchObject({code:'vision_unavailable'});
    expect(calls).toBe(0);
  });
  it.each(['Insufficient account balance', 'invalid_api_key', 'quota exceeded'])('does not retry a 400 service failure: %s', async message => {
    const sent=[];const router=createVisionRouter({config,analysis,fetchImpl:async(_,init)=>{const b=JSON.parse(init.body);sent.push(b.model);return b.model==='analysis'?new Response(message,{status:400}):answer('seen');}});
    await router.ask(request);
    expect(sent).toEqual(['analysis','edit']);
    expect(router.snapshot().capabilities[0].video).toBeNull();
  });
  it('records the resolved local model and actual usage, including an invalid optional configuration reason once', async () => {
    const router=createVisionRouter({config:{runtime:'codex',model:''},analysisIssue:'地址格式无效',localAi:{ask:async(_runtime,options)=>{options.onModel?.('resolved-model');options.onUsage?.({input_tokens:15,output_tokens:4});return 'seen';}}});
    await router.ask({...request,inputMode:'images'});await router.ask({...request,inputMode:'images'});
    expect(router.snapshot().calls[0]).toMatchObject({model:expect.stringContaining('resolved-model'),requestedModel:null,usage:{input_tokens:15,output_tokens:4}});
    expect(router.snapshot().events).toHaveLength(1);
    expect(router.note()).toContain('解析模型配置不可用');
  });
});
