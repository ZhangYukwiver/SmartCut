import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AiEditError } from "./library.mjs";
import { subjectPlayback } from "./subjectPlayback.mjs";
import { subjectEffects } from "./subjectEffects.mjs";
import { subjectMotion } from "./subjectMotion.mjs";
import { subjectCarousel } from "./subjectCarousel.mjs";
import sharp from "sharp";
import {cachedImageModel,runImageWorker} from './cutout.mjs';

const execute = promisify(execFile);
const swift = fileURLToPath(new URL("./subjectWorker.swift", import.meta.url));
const failure = (message) => new AiEditError("subject_tracking_failed", message, 422);
const poseWorker=new URL('./subjectPoseWorker.mjs',import.meta.url);
const POSE_MODEL={id:'mediapipe-handpose-2023feb-db0898ae',label:'三维手姿',code:'subject_pose_model_unavailable',url:'https://media.githubusercontent.com/media/opencv/opencv_zoo/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/handpose_estimation_mediapipe/handpose_estimation_mediapipe_2023feb.onnx',bytes:4099621,sha256:'db0898ae717b76b075d9bf563af315b29562e11f8df5027a1ef07b02bef6d81c'};

// A foreground mask can have a transparent antialiasing border. Sample just inside
// it, but report the contact on the original image edge, never on a cropped ROI edge.
export function subjectBoundarySupport(data,{width,height,channels},rect=[0,0,1,1]) {
  const hits=[],edges=[];const inset=Math.min(2,Math.floor(Math.min(width,height)/4));
  const alpha=(x,y)=>data[(y*width+x)*channels+channels-1];
  const sample=(name,allowed,length,at)=>{if(!allowed)return;let count=0;
    for(let i=inset;i<length-inset;i++){const [x,y,u,v]=at(i);if(alpha(x,y)>=128){hits.push([u,v]);count++;}}
    if(count>=4)edges.push(name);
  };
  sample('left',rect[0]<.002,height,i=>[inset,i,0,rect[1]+i/height*rect[3]]);
  sample('right',rect[0]+rect[2]>.998,height,i=>[width-1-inset,i,1,rect[1]+i/height*rect[3]]);
  sample('top',rect[1]<.002,width,i=>[i,inset,rect[0]+i/width*rect[2],0]);
  sample('bottom',rect[1]+rect[3]>.998,width,i=>[i,height-1-inset,rect[0]+i/width*rect[2],1]);
  if(hits.length<8||edges.length>2||edges.includes('left')&&edges.includes('right')||edges.includes('top')&&edges.includes('bottom'))return null;
  return {edgeAnchor:[0,1].map(k=>hits.reduce((n,p)=>n+p[k],0)/hits.length),edges,samples:hits.length,method:'observed-mask-frame-contact'};
}

async function executable(root, digest, signal) {
  if (swift.includes(".asar" + path.sep)) return path.join(process.resourcesPath,"smartcut-subject");
  const cache = path.join(root,"subject-worker");
  await mkdir(cache,{recursive:true});
  const binary = path.join(cache,"worker-"+digest);
  if (await stat(binary).catch(() => null)) return binary;
  const stage = await mkdtemp(path.join(cache,".build-"));
  try {
    const temp = path.join(stage,"worker");
    await execute("/usr/bin/xcrun",["swiftc","-O","-suppress-warnings",swift,"-o",temp],{signal,timeout:120_000});
    await rename(temp,binary);
    return binary;
  } finally { await rm(stage,{recursive:true,force:true}); }
}

export async function trackSubject(ctx, { clip_id, mode, seed }) {
  if (process.platform !== "darwin" || Number(os.release().split(".")[0]) < 23) {
    throw failure("本机主体分析需要 macOS 14 或更新版本；已导出的跟踪工程可跨平台播放。");
  }
  if (!["body","hand"].includes(mode) || !Array.isArray(seed) || seed.length!==2 || !seed.every(n=>Number.isFinite(n)&&n>=0&&n<=1))
    throw failure("请指定 body 或 hand，并给出首帧目标躯干或手掌的归一化坐标。");
  const clip = await ctx.store.getSegment(ctx.projectId,clip_id);
  if (clip.kind!=="video" || clip.curve_speed) throw failure("请选择恒定倍速的视频片段。");
  const start=clip.source.start_us/1e6, length=clip.source.duration_us/1e6, speed=clip.speed ?? 1;
  if (!(length>0 && length<=12 && speed>0)) throw failure("请选取不超过 12 秒的连续原片。");
  const mediaId=ctx.library.idForPath(clip.path), file=ctx.library.readyPath(mediaId);
  const [source,info]=await Promise.all([readFile(swift),stat(file)]);
  const digest=createHash("sha256").update(source).digest("hex").slice(0,16);
  const duration = clip.timeline.duration_us / 1e6;
  const key=createHash("sha256").update(digest).update(await readFile(poseWorker)).update(POSE_MODEL.sha256).update(subjectPlayback.toString()).update(subjectEffects.toString()).update(subjectMotion.toString()).update(subjectCarousel.toString()).update(subjectBoundarySupport.toString()).update(JSON.stringify([os.release(),mediaId,info.size,info.mtimeMs,start,length,duration,speed,mode,seed])).digest("hex").slice(0,24);
  const root=path.dirname(ctx.library.root), pages=path.join(root,"pages"), folder="_subject_"+key, dest=path.join(pages,folder);
  const meta=async()=>JSON.parse(await readFile(path.join(dest,"summary.json"),"utf8"));
  let summary;
  try {summary=await meta();} catch(e){if(e.code!=="ENOENT") throw e;}
  if (!summary) {
    await mkdir(pages,{recursive:true});
    const stage=await mkdtemp(path.join(pages,".subject-"));
    ctx.onGenerating?.("正在本机逐帧识别主体、关节和遮挡轮廓…");
    try {
      const binary=await executable(root,digest,ctx.signal);
      const result=await execute(binary,[file,stage,mode,String(start),String(length),...seed.map(String)],{signal:ctx.signal,timeout:360_000,maxBuffer:1024*1024});
      summary=JSON.parse(result.stdout);
      const poseSignal=ctx.signal??new AbortController().signal,progress=s=>ctx.onGenerating?.(s);
      const model=await cachedImageModel(root,POSE_MODEL,poseSignal,progress);
      await runImageWorker({folder:stage,model,size:summary.size},{signal:poseSignal,progress,workerURL:poseWorker,label:'三维手姿',code:'subject_pose'});
      summary.pose3D=JSON.parse(await readFile(path.join(stage,'pose-summary.json')));
      const rows=JSON.parse(await readFile(path.join(stage,"frames.json"),"utf8"));
      if(mode==='hand')for(const row of rows){if(!row.matte)continue;const {data,info}=await sharp(path.join(stage,row.matte)).toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});row.support=subjectBoundarySupport(data,info,row.rect);}
      const frames=JSON.stringify(rows);
      const ref='window.smartcutSubjects['+JSON.stringify(key)+']';
      const script="(window.smartcutSubjects??={})["+JSON.stringify(key)+"]=("+subjectPlayback.toString()+")("+frames+","+JSON.stringify(summary.size)+","+speed+","+duration+",document.currentScript.src);"+ref+'.kind='+JSON.stringify(mode)+';'+ref+'.motion=('+subjectMotion.toString()+')('+ref+',('+subjectCarousel.toString()+'));'+ref+'.effects=('+subjectEffects.toString()+')('+ref+');';
      await writeFile(path.join(stage,"track.js"),script);
      await writeFile(path.join(stage,"analysis.json"),JSON.stringify({frames:rows,size:summary.size,start,length,speed,duration,mediaId,mode}));
      await rm(path.join(stage,"frames.json"));
      await writeFile(path.join(stage,"summary.json"),JSON.stringify(summary));
      ctx.signal?.throwIfAborted();
      try {await rename(stage,dest);} catch(e){if (!["EEXIST","ENOTEMPTY"].includes(e.code)) throw e;summary=await meta();}
    } catch(e){
      if(ctx.signal?.aborted) throw e;
      throw failure("主体跟踪未完成："+String(e.stderr?.trim() || e.message).slice(-340));
    } finally {await rm(stage,{recursive:true,force:true});ctx.onGenerating?.(null);}
  }
  const src="../"+folder+"/track.js";
  const analysis=JSON.parse(await readFile(path.join(dest,'analysis.json'),'utf8'));
  const events=subjectMotion(subjectPlayback(analysis.frames,analysis.size,speed,duration,'file:///track.js')).gestures();
  return { ...summary, mode, track_id:key, script_src:src,
    gesture_candidates:{swipes:events.swipes,presses:events.presses,limitation:events.limitation},
    motion: {usage:'const events=s.motion.gestures(); 返回 swipes(start/end/from/to/dx)、presses(time/point/status:candidate)。事件来自原片关节运动，不是固定秒数。const selection=s.motion.selector({targets:t=>[{id,rect:[x,y,w,h]}],events}); targets必须等于当时真正绘制的封面归一化矩形，默认只接受最后一次滑动之后的按压候选。selection.events包含命中后的confirmed事件；const state=selection.at(t)精确返回{selected:当前命中id或null,confirmed:boolean,event?:确认事件,feedbackOpacity:0到1,ready:boolean}。画高亮用state.selected===卡片id，没有state.target或state.highlight字段。只使用选中目标对应的确认事件；没有命中时调整实际布局或报告未确认，禁止手工构造event对象。二维按压候选不是实际触屏深度。',
      binding:'完整手臂使用 s.effects.bindHand({hand:"hand",calibrationTime:确认事件.time,size:[4,4,12],roll:25,texture,uv})。默认端面中心为knuckles掌骨中心，入画根部来自本轮遮罩的边界接触或可见肘部；按观测掌宽×widthScale(默认1.2)拟合三维截面和depthRatio。不要另写endpoint:indexTip或随意固定depthRatio。actor.calibration返回目标/投影掌宽、拟合误差和根部证据，误差超过12%不得宣称校准成功。刚体运动仍用手腕和掌骨传递，不将弯指当整臂缩放。全身仍可使用bindCuboid绑定肘腕等骨骼。',
      feedback:'selector默认feedback:{enter:.24,hold:.25}；也可显式配置，但hold至少.15。UI确认卡透明度必须使用selection.at(t).feedbackOpacity，完整显示后还需hold停留；确认event.feedback.readyAt为反馈完成时刻。replacement.transition会从readyAt之后启动，delay是额外延时，不再从点击发生时刻计时。不要用独立的clamp((t-event.time)/...)重造不同反馈时钟。'},
    carousel:'滑动选封面只创建一个 s.motion.carousel({items:[{id,label}],viewport:[x,y,w,h],center:[x,y],card:[w,h],spacing:360,initialIndex:2,start:.65,browseUntil:浏览结束时刻,gain:1,requiredDirections:["left","right"]})，所有布局单位为原片像素。browseUntil只结束拖动浏览，之后移手仍可命中封面并点击确认；end是整个交互结束时刻，不能用end代替browseUntil。drags、状态和确认事件只读，禁止splice或修改内部数据。每帧 const state=carousel.draw(ctx,t,{images:{id:已解码图片},opacity,showLabel:false}) 绘制真实卡片；showLabel:false仅关闭内置底部标题，页面可用state.item.label、state.selectedIndex+1、state.selected统一绘制标题、编号和装饰，不要另用Math.round(position)或第二套控制器算选中。carousel.at(t)与carousel.selection.at(t)返回同一状态：phase/selected/selectedIndex/item/position/cards/confirmed/event/feedbackOpacity/ready；selection.events只暴露首次真实命中的确认事件。将同一carousel.selection.events里的事件用于手臂变身，禁止保留旧轮播只管点击。draw和motion.audit核对实际逐帧跟随、吸附、选中封面、高亮和确认的一致性，不能用静态绘图或旧控制器覆盖失败。start须为UI已出现时刻，末次浏览滑动停稳才接受按压确认。',
    pose3D:summary.pose3D,
    model_continuation:'原片结束后可对三维模型续演，而不是伪造实拍：bindHand({pose:"3d",...,motion:[{time:s.duration,swing:[0,0,0],twist:0},{time:s.duration+.8,swing:[0,18,24],twist:25}]})。swing为相机坐标欧拉摆动角，围绕模型根部旋转；twist为绕前臂轴额外转腕角。关键帧必须在原片结束后、首帧零偏置，否则拒绝。fx.draw传时间线t与截到原片末帧的sourceTime；运行时分别使用动作时钟和源帧时钟。audit标记authored-model-motion，交付不得称作新增真实跟踪。为避免先抹掉手指后模型另现，transition.direction:"from-root"可从前臂向手部连续替换；默认to-root保持旧行为。',
    depth_binding:'本轮已运行本地MediaPipe三维手姿网络。优先 const actor=s.effects.bindHand({hand:"hand",calibrationTime:confirmed.time,pose:"3d",atlas,texture,widthScale:1.2})；不要传roll:25或depthRatio，三维掌面决定轴向旋转，roll仅是额外艺术偏置且默认0。actor.kind应为hand-pose-3d，calibration.method为neural-depth-and-palm-normal。s.motion.hand3D(t)返回相机投影拟合后的camera关节、置信度、重投影误差；短缺口只在两侧可靠且二维身份仍在时插值并标记temporalBridge。不支持用二维替代缺失三维而宣称通过。焦距与体型尺度为先验，未见肘部时前臂方向仍由掌面先验和可见轮廓约束，不是深度相机测量。',
    effects: { version:4, depth:'单目神经手姿、相机投影拟合与轮廓约束；不是测量深度',
      atlas:'通用方块网格展开贴图使用 const atlas=s.effects.cuboidAtlas({x:40,y:16,width:4,depth:4,length:12}); bindHand({...,atlas,texture})。坐标示例适用于64x64 Steve原皮肤右臂。接口定义start为近端/肩部、end为远端/拳端，并自动生成六面UV；不要把肩部青色面当作拳端，也不再手写互换start/end的表。可调整网格起点/尺寸用于其它方块贴图。',
      usage:'s.effects.bindCuboid({start,end,size:[宽,厚,长],depthRatio:.72,roll:25,twist:[关节名,关节名],texture:已解码图片,uv:{front:[x,y,w,h],back:[],left:[],right:[],end:[],start:[]}}) 返回 actor，start/end 为关节名或原图归一化[x,y]；可用身体肘腕或手指，也可将 start 放在画面外延续整条前臂。roll 为角度或(t)=>角度；twist 可选，给掌指关节对估计转腕，深度比例是近端/远端。actor.pose(t) 返回投影面/深度/轮廓，actor.draw(ctx,t) 绘制带透视纹理、旋转、面剔除与光照的立方肢体。三帧平滑不补造丢失当前帧。',
      replacement:'const fx=s.effects.replacement({actor,part:"subject",region:"limb",margin:6,transition:{event:实际命中确认事件,delay:.18,duration:1.1,cell:12,color:"#c5ff97"}}); await fx.draw(ctx,t,{background:本轮逐帧配准背景,behind:本帧未扣真人手的HUD画布,texture:皮肤图片,sourceTime:t}); 它先让真人挡住HUD，转场后清除选定肢体、恢复被旧手挡住的HUD，再画三维模型；同一像素波驱动清理、显现、发光和粒子。先检查原始主体遮罩：若已隔离为仅一条手臂含袖口，使用region=subject，以完整原遮罩清理，不按新模型外形截断原袖口；若遮罩包含整个人而只换局部，用region=limb限制肢体区域，并复核区域外残留。不能仅因检测到一只手就假定遮罩没有躯干。其他人物遮挡应另行处理。多个身体部位可传 actors:[actor1,actor2]。支持单独 actor.draw 与 s.occlude 自行决定前后层。',
      timing:'转场 origin 默认模型 end，终点默认模型 start；由指尖向画面边缘推进。画布尺寸须与原片一致。原片结束要延长展示，必须先在时间线添加本轮末帧，再显式传 sourceTime=Math.min(t,s.duration-1/30)，不假造检测动作。干净背景只能来自本轮原片修复，不能截旧效果。所有图片在 HTML 用静态 src 引用并在 film.ready 中 decode，轨迹和内置能力随工程导出。' },
    replacement_v3:'先 build_subject_background(同一clip_id,track_id,reference_time)，引入返回的背景脚本。fx=s.effects.replacement({actor,region:"limb",transition:{event:selection.events.find(e=>e.target==="minecraft"),duration:.8,cell:10},foreground:[]}); await fx.draw(ctx,t,{background:smartcutBackgrounds[id],behind:本帧HUD,texture,sourceTime:Math.min(t,s.duration-1/30)}); 转场在确认卡完整显示并停留之后启动，不另写固定秒数。像素格绑定肢体坐标，粒子位置固定在出生帧，不随当前手臂位置重算；裁切或错位的自定义时钟需同时传sourceTimeAt:出生时刻=>原片时刻。若其它手/人物在模型前，foreground:[{part:"right",source:原片当前帧,when:t=>此段在前}]可恢复其真实像素；人物交叉须声明层次，不能假称自动测量深度。s.effects.audit()同时检查掌宽校准、根部来源、反馈完成顺序、绑定、背景和UV。',
    occlusion_parts: { subject:"整个选定主体", hands:"检测到的手掌和手指", left:"左手", right:"右手", arms:"前臂和手遮住胸牌，优先使用可见的肘腕关节", leftArm:"左前臂和手", rightArm:"右前臂和手" },
    usage:`页引入 <script src="${src}"></script>；const s=smartcutSubjects["${key}"]。t 为本片段入点起的时间线秒数。s.point(t,"leftWrist") 或 s.point(t,"hand.indexTip") 返回原画面归一化 [x,y,confidence]，低置信度/离屏返回 null；body 模式用 left/right 指定身体侧，例如 "right.indexTip"。s.at(t) 提供完整 body/hands。s.bone(t,"leftShoulder","leftElbow") 或 s.bone(t,"hand.wrist","hand.middleMCP") 给出二维 angle、原图像素 length 和锚点。先在透明画布画效果，再 await s.occlude(ctx,t,"subject") 让人挡住效果；选 "hands"/"left"/"right" 则只让手遮挡，整个效果在最前时无需扣除。默认源图铺满画布，否则传第4参数 [x,y,w,h] 对齐底片。遮挡次序由场景指定，手掌跨躯干使用关节引导的近似手形，不提供场景深度。跟丢时返回空，不要补造动作。` };
}
