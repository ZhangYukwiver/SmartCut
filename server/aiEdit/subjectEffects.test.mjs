import { describe, expect, it } from 'vitest';
import { subjectEffects } from './subjectEffects.mjs';
import { chromeProvider, findBrowser, openTab } from './film/browser.mjs';
import { createToolRunner } from './tools.mjs';

const observation = t => t<0 || t>2 ? null : { wrist:[.3,.8,.8],tip:[.62,.3,.9],leftElbow:[.12,.92,.8],leftWrist:[.58,.35,.9] };
const track = {size:[1920,1080],point:(t,key)=>observation(t)?.[key]??null};

describe('subject replacement geometry and compositing',()=>{
  it('gives native pages the stored texture path rather than guessing from a display name',async()=>{
    const item={id:'a'.repeat(32),name:'皮肤.jpg',kind:'image',status:'ready',width:64,height:64,source:{type:'local'}};
    const run=createToolRunner({library:{list:()=>[item],readyPath:()=>'/private/validation/media/'+item.id+'.png'},store:{},projectId:'p'});
    const {result}=await run('list_media',{});
    expect(result.media[0].page_src).toBe('../../media/'+item.id+'.png');
  });
  it('projects a real volume with rotation, perspective and depth ordering for hand or body anchors',()=>{
    const fx=subjectEffects(track),base={start:[-.08,1.08],end:'tip',size:[4,4,12]};
    const a=fx.bindCuboid({...base,roll:10}).pose(1),b=fx.bindCuboid({...base,roll:65}).pose(1);
    expect(a.end).toEqual([.62*1920,.3*1080]);
    expect(a.depth.near).toBeLessThan(a.depth.far);
    expect(a.faces.length).toBeGreaterThanOrEqual(2);
    expect(a.faces.map(f=>f.depth)).toEqual(a.faces.map(f=>f.depth).sort((a,b)=>b-a));
    expect(a.silhouette).not.toEqual(b.silhouette);
    const depth=fx.bindCuboid({...base,depthRatio:.45}).pose(1);
    expect(depth.silhouette).not.toEqual(a.silhouette);
    expect(fx.bindCuboid({start:'leftElbow',end:'leftWrist'}).pose(1)).not.toBeNull();
    expect(fx.bindCuboid(base).pose(2.1)).toBeNull();
  });
  it('makes the same directed wave on random access and never starts before the confirmation gate',()=>{
    const fx=subjectEffects(track),config={start:3.7,duration:1,origin:[120,20],end:[120,150],cell:10};
    expect(fx.pixelWave(3.69,config,240,160).progress).toBe(0);
    const halfway=fx.pixelWave(4.2,config,240,160);
    expect(halfway.cells.find(c=>c.x===120&&c.y===40).replaced).toBe(true);
    expect(halfway.cells.find(c=>c.x===120&&c.y===120).replaced).toBe(false);
    fx.pixelWave(4.7,config,240,160);
    expect(fx.pixelWave(4.2,config,240,160)).toEqual(halfway);
  });
  it('keeps transition cells on the moving limb and particles at their birth poses',()=>{
    const fx=subjectEffects(track),config={start:1,duration:1,origin:[90,20],end:[90,145],cell:10,space:'limb'};
    const a=fx.pixelWave(1.5,config,300,200),b=fx.pixelWave(1.5,{...config,origin:[107,31],end:[107,156]},300,200);
    const cell=a.cells.find(c=>c.u===0&&c.v===5),moved=b.cells.find(c=>c.u===0&&c.v===5);
    expect(moved.coverage).toBe(cell.coverage);expect(moved.corners[0][0]-cell.corners[0][0]).toBeCloseTo(17);expect(moved.corners[0][1]-cell.corners[0][1]).toBeCloseTo(11);
    const poseAt=t=>({end:[100+t*200,20],start:[100+t*200,160],width:40});
    const first=fx.particles(1.5,config,poseAt),second=fx.particles(1.52,config,poseAt),p=first.find(p=>second.some(q=>q.id===p.id));
    expect(second.find(q=>q.id===p.id).origin).toEqual(p.origin);
    fx.particles(1.8,config,poseAt);expect(fx.particles(1.5,config,poseAt)).toEqual(first);
  });
  it.skipIf(!findBrowser())('restores UI behind a removed subject without white holes, preserves the original before the gate and refuses missing poses',async()=>{
    const provider=chromeProvider();let tab;
    const html=`<canvas id="c" width="240" height="160"></canvas><script>
    const createEffects=${subjectEffects.toString()};
    window.film={duration:4,frame(){}};
    window.check=async()=>{
      const c=document.getElementById('c'),g=c.getContext('2d');
      const image=color=>{const x=document.createElement('canvas');x.width=240;x.height=160;const z=x.getContext('2d');z.fillStyle=color;z.fillRect(0,0,240,160);return x};
      const clean=image('#888888'),behind=image('#0000ff');behind.getContext('2d').clearRect(0,110,240,50);
      let missing=false,hasMask=true,hands={},secondHand=false,overlap=false;
      const track={size:[240,160],point:()=>[.5,.3,1],at:()=>({matte:hasMask?'mask.png':null,hands}),async occlude(ctx,t,part){ctx.save();ctx.globalCompositeOperation='destination-out';if(part!=='right')ctx.fillRect(75,60,70,70);if(secondHand)ctx.fillRect(...(overlap?[125,65,20,30]:[195,60,30,70]));ctx.restore();return hasMask}};
      const pose={start:[60,150],end:[125,45],width:40,silhouette:[[120,50],[135,50],[135,95],[120,95]],depth:{near:1,far:2},rotation:0};
      const actor={pose:()=>missing?null:pose,draw(ctx){ctx.fillStyle='#00ff00';ctx.fillRect(120,50,15,45)}};
      const fx=createEffects(track).replacement({actor,region:'subject',margin:0,transition:{start:1,duration:1,cell:10}});
      const at=(x,y)=>Array.from(g.getImageData(x,y,1,1).data);
      await fx.draw(g,.9,{clean,behind});const before=at(100,80);
      const finished=await fx.draw(g,2.1,{clean,behind});const after={hud:at(100,80),clean:at(100,120),model:at(125,75),outside:at(20,140)};
      await fx.draw(g,.9,{clean,behind});const back=at(100,80);
      missing=true;const lost=await fx.draw(g,2.1,{clean,behind});const retained=at(100,80);
      missing=false;hasMask=false;const noMask=await fx.draw(g,2.1,{clean,behind});
      hasMask=true;secondHand=true;hands={left:{indexMCP:[.5,.45,1],littleMCP:[.3,.55,1],indexTip:[.6,.4,1],wrist:[.4,.75,1]},right:{indexMCP:[.9,.45,1],littleMCP:[.8,.55,1],indexTip:[.95,.4,1]}};
      actor.options={end:'hand.indexTip'};
      const limb=createEffects(track).replacement({actor,region:'limb',margin:0,transition:{start:1,duration:1,cell:10}});
      await limb.draw(g,2.1,{clean,behind});
      const knuckle=at(100,65),otherHand=at(205,80);overlap=true;
      const crossing=createEffects(track).replacement({actor,region:'subject',margin:0,foreground:[{part:'right',source:image('#ff0000'),when:t=>t<2.2}],transition:{start:1,duration:1,cell:10}});
      await crossing.draw(g,2.1,{clean,behind});const inFront=at(130,75);
      await crossing.draw(g,2.3,{clean,behind});const behindArm=at(130,75);
      const texture=document.createElement('canvas');texture.width=64;texture.height=64;const tg=texture.getContext('2d');tg.fillStyle='#00ff00';tg.fillRect(0,0,64,64);tg.fillStyle='#0000ff';tg.fillRect(44,16,4,4);tg.fillStyle='#ff0000';tg.fillRect(48,16,4,4);
      const api=createEffects(track),atlas=api.cuboidAtlas({x:40,y:16,width:4,depth:4,length:12}),capColors={};
      for(const [face,depthRatio] of [['start',.4],['end',1.3]]){const box=api.bindCuboid({start:[.5,.85],end:[.5,.3],depthRatio,atlas,texture}),p=box.pose(0);const f=p.faces.find(f=>f.name===face);if(!f)throw Error('Expected visible cap '+face);g.clearRect(0,0,240,160);box.draw(g,0,{shadow:false});const c=p.project(f.at(.5,.5));capColors[face]=at(Math.floor(c[0]),Math.floor(c[1]));}
      return {before,after,back,finished:finished.state,lost:lost.state,retained,noMask:noMask.state,knuckle,otherHand,inFront,behindArm,capColors};
    };</script>`;
    try {
      tab=await openTab(provider,'data:text/html;charset=utf-8,'+encodeURIComponent(html),{width:240,height:160});
      const r=await tab.evaluate('window.check()');
      expect(r.before[3]).toBe(0);expect(r.back).toEqual(r.before);
      expect(r.after.hud).toEqual([0,0,255,255]);expect(r.after.clean).toEqual([136,136,136,255]);
      expect(r.after.model).toEqual([0,255,0,255]);expect(r.after.outside[3]).toBe(0);
      expect(r.finished).toBe('replaced');expect(r.lost).toBe('tracking-unavailable');expect(r.retained[3]).toBe(0);expect(r.noMask).toBe('mask-unavailable');
      expect(r.knuckle).toEqual([0,0,255,255]);expect(r.otherHand[3]).toBe(0);
      expect(r.inFront).toEqual([255,0,0,255]);expect(r.behindArm).toEqual([0,255,0,255]);
      expect(r.capColors.start[2]).toBeGreaterThan(100);expect(r.capColors.start[0]).toBe(0);
      expect(r.capColors.end[0]).toBeGreaterThan(100);expect(r.capColors.end[2]).toBe(0);
    } finally {await tab?.close();await provider.close();}
  },60000);
});
