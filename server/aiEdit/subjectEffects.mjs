// Serialized into each subject track. No editor globals or external dependencies.
// Depth is a perspective constraint supplied by the author, not a measured depth map.
export function subjectEffects(track) {
  const bindings=[],replacements=[];
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const mul = (a, n) => a.map(v => v * n);
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const unit = a => mul(a, 1 / (Math.hypot(...a) || 1));
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const hash = n => { const x = Math.sin(n * 127.13 + 17.7) * 43758.5453; return x - Math.floor(x); };
  const smooth = x => { x = clamp(x); return x*x*(3-2*x); };
  const polygon = (ctx, points) => { ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.closePath(); };
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width=w; c.height=h; return c; };
  const hull = points => {
    const sorted = points.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    const half = list => { const out=[]; for(const p of list){ while(out.length>1){const a=sub(out.at(-1),out.at(-2)),b=sub(p,out.at(-1));if(a[0]*b[1]-a[1]*b[0]>0)break;out.pop();}out.push(p);}return out.slice(0,-1); };
    return half(sorted).concat(half(sorted.slice().reverse()));
  };
  const textures = new WeakMap();
  function modelMotion(t,keys){
    if(!keys?.length||t<=keys[0].time)return {swing:[0,0,0],twist:0};
    let i=1;while(i<keys.length&&keys[i].time<t)i++;
    const a=keys[i-1],b=keys[Math.min(i,keys.length-1)],u=a===b?1:smooth((t-a.time)/(b.time-a.time));
    return {swing:[0,1,2].map(k=>(a.swing?.[k]??0)*(1-u)+(b.swing?.[k]??0)*u),twist:(a.twist??0)*(1-u)+(b.twist??0)*u};
  }
  function rotate3D(p,angles){
    const [rx,ry,rz]=angles.map(v=>v*Math.PI/180),a=[p[0],p[1]*Math.cos(rx)-p[2]*Math.sin(rx),p[1]*Math.sin(rx)+p[2]*Math.cos(rx)],b=[a[0]*Math.cos(ry)+a[2]*Math.sin(ry),a[1],-a[0]*Math.sin(ry)+a[2]*Math.cos(ry)];
    return [b[0]*Math.cos(rz)-b[1]*Math.sin(rz),b[0]*Math.sin(rz)+b[1]*Math.cos(rz),b[2]];
  }
  function cuboidAtlas({x=0,y=0,width,depth=width,length}={}){
    if(![x,y,width,depth,length].every(Number.isInteger)||x<0||y<0||width<1||depth<1||length<1)throw Error('方块展开贴图需要非负起点与正整数尺寸');
    // Root-to-tip length runs down the side strip. The cap above its front face is
    // the root (shoulder); the adjacent cap is the distal end (fist), not vice versa.
    return {kind:'box-net',size:[width,depth,length],uv:{front:[x+depth,y+depth,width,length],back:[x+depth+width+depth,y+depth,width,length],left:[x+depth+width,y+depth,depth,length],right:[x,y+depth,depth,length],start:[x+depth,y,width,depth],end:[x+depth+width,y,width,depth]}};
  }
  function pixels(image) {
    if (!image || !(image.naturalWidth || image.width)) throw Error('三维绑定需要已加载的纹理图片');
    if (!textures.has(image)) {
      const w=image.naturalWidth||image.width,h=image.naturalHeight||image.height,c=canvas(w,h),g=c.getContext('2d');
      g.drawImage(image,0,0); textures.set(image,{w,h,data:g.getImageData(0,0,w,h).data});
    }
    return textures.get(image);
  }
  function sample(t, anchor, radius = 1/30) {
    if (typeof anchor==='function') return anchor(t);
    if (Array.isArray(anchor) && anchor.length===2 && anchor.every(Number.isFinite)) return anchor.slice();
    if (typeof anchor !== 'string') return null;
    const current=track.point(t,anchor);
    if (!current) return null; // Never fill a missing current observation with an invented pose.
    const points=[[-radius,.2],[0,.6],[radius,.2]].map(([dt,w])=>[track.point(t+dt,anchor),w]).filter(([p])=>p);
    const total=points.reduce((v,[,w])=>v+w,0);
    return [0,1].map(i=>points.reduce((v,[p,w])=>v+p[i]*w,0)/total);
  }
  function bindCuboid(options) {
    options={...options,size:options.size??options.atlas?.size,uv:options.uv??options.atlas?.uv};
    const size=options.size??[4,4,12], fov=options.fov??60;
    if(!Array.isArray(size)||size.length!==3||!size.every(n=>Number.isFinite(n)&&n>0)||!(fov>10&&fov<150)) throw Error('三维模型尺寸、深度比例或视场角无效');
    if(options.motion){
      if(!options.frame3D||!Array.isArray(options.motion)||options.motion.length<2||options.motion.some((k,i)=>!Number.isFinite(k.time)||k.time<track.duration||(i&&k.time<=options.motion[i-1].time)||![...(k.swing??[0,0,0]),k.twist??0].every(v=>Number.isFinite(v)&&Math.abs(v)<=90))||options.motion[0].swing?.some(v=>v!==0)||options.motion[0].twist)throw Error('模型续演需要原片结束后的递增关键帧，以零偏置开始，不能覆盖实拍跟踪');
    }
    const pose = (t, viewport=track.size,sceneTime=t) => {
      const ratio=typeof options.depthRatio==='function'?options.depthRatio(t):options.depthRatio??.72;
      if(!(ratio>.15&&ratio<2))throw Error('三维深度比例无效');
      let frame3D=options.frame3D?.(t);
      if(options.frame3D&&!frame3D)return null;
      const continuation=modelMotion(sceneTime,options.motion);
      if(frame3D&&options.motion)frame3D={...frame3D,end:add(frame3D.start,rotate3D(sub(frame3D.end,frame3D.start),continuation.swing)),across:rotate3D(frame3D.across,continuation.swing)};
      const a=sample(t,options.start,options.smoothing), b=sample(t,options.end,options.smoothing);
      if(!a||!b) return null;
      const [w,h]=viewport;let start=[a[0]*w,a[1]*h],end=[b[0]*w,b[1]*h];
      if(Math.hypot(...sub(start,end))<2) return null;
      const f=w/(2*Math.tan(fov*Math.PI/360)), ray=p=>[(p[0]-w/2)/f,(p[1]-h/2)/f,1];
      const ar=ray(start),br=ray(end),farDepth=size[2]/Math.hypot(...sub(br,mul(ar,ratio)));
      const near=frame3D?.start??mul(ar,farDepth*ratio),far=frame3D?.end??mul(br,farDepth),axis=unit(sub(far,near));
      const viewAcross=unit(cross(axis,unit(add(near,far)))),viewUp=unit(cross(axis,viewAcross));
      let across=frame3D?unit(sub(frame3D.across,mul(axis,dot(frame3D.across,axis)))):viewAcross;
      if(Math.hypot(...across)<.01) across=[1,0,0];
      const up=unit(cross(axis,across));
      let roll=((typeof options.roll==='function'?options.roll(t):options.roll??25)+continuation.twist)*Math.PI/180;
      if(options.twist){
        const x=sample(t,options.twist[0]),y=sample(t,options.twist[1]);
        const rt=options.calibrationTime??0,rx=sample(rt,options.twist[0]),ry=sample(rt,options.twist[1]),ra=sample(rt,options.start),rb=sample(rt,options.end);
        if(x&&y&&rx&&ry&&ra&&rb){const angle=(a,b,c,d)=>Math.atan2((b[1]-a[1])*h,(b[0]-a[0])*w)-Math.atan2((d[1]-c[1])*h,(d[0]-c[0])*w);let delta=angle(x,y,a,b)-angle(rx,ry,ra,rb);delta=Math.atan2(Math.sin(delta),Math.cos(delta));roll+=clamp(delta,-Math.PI/3,Math.PI/3)*(options.twistWeight??1);}
      }
      const x=add(mul(across,Math.cos(roll)),mul(up,Math.sin(roll))),y=add(mul(across,-Math.sin(roll)),mul(up,Math.cos(roll)));
      const vertex=(u,v,z)=>add(near,add(add(mul(x,u),mul(y,v)),mul(axis,z)));
      const project=p=>[w/2+f*p[0]/p[2],h/2+f*p[1]/p[2]];
      if(frame3D){start=project(near);end=project(far);}
      const [sx,sy,sz]=size;
      const sides=[
        {name:'right',normal:x,at:(u,v)=>vertex(sx/2,(u-.5)*sy,v*sz)},
        {name:'left',normal:mul(x,-1),at:(u,v)=>vertex(-sx/2,(.5-u)*sy,v*sz)},
        {name:'front',normal:mul(y,-1),at:(u,v)=>vertex((u-.5)*sx,-sy/2,v*sz)},
        {name:'back',normal:y,at:(u,v)=>vertex((.5-u)*sx,sy/2,v*sz)},
        {name:'end',normal:axis,at:(u,v)=>vertex((u-.5)*sx,(v-.5)*sy,sz)},
        {name:'start',normal:mul(axis,-1),at:(u,v)=>vertex((u-.5)*sx,(.5-v)*sy,0)},
      ];
      if(sides.some(face=>[[0,0],[1,0],[1,1],[0,1]].some(([u,v])=>face.at(u,v)[2]<=.001)))return null;
      const light=unit(options.light??[-.45,-.7,-1]);
      const faces=sides.filter(face=>dot(face.normal,face.at(.5,.5))<0).map(face=>({...face,
        depth:face.at(.5,.5)[2], shade:.62+.38*Math.max(0,dot(face.normal,light)),
        corners:[[0,0],[1,0],[1,1],[0,1]].map(([u,v])=>project(face.at(u,v)))
      })).sort((a,b)=>b.depth-a.depth);
      if(faces.some(face=>face.corners.flat().some(v=>!Number.isFinite(v))))return null;
      const silhouette=hull(sides.flatMap(face=>[[0,0],[1,0],[1,1],[0,1]].map(([u,v])=>project(face.at(u,v)))));
      const cap=[[-sx/2,-sy/2],[sx/2,-sy/2],[sx/2,sy/2],[-sx/2,sy/2]].map(([u,v])=>project(vertex(u,v,sz)));
      const along=unit(sub(end,start)),normal=[-along[1],along[0]],capPositions=cap.map(p=>dot(p,normal));
      return {start,end,faces,silhouette,cap,capSpan:Math.max(...capPositions)-Math.min(...capPositions),project,depth:{near:near[2],far:far[2],estimated:Boolean(frame3D)},rotation:roll+(frame3D?Math.atan2(dot(across,viewUp),dot(across,viewAcross)):0),width:Math.hypot(...sub(project(vertex(sx/2,0,sz)),project(vertex(-sx/2,0,sz))))};
    };
    function draw(ctx,t,{texture=options.texture,sourceTime=t,shadow=true,onlyFace}={}) {
      const p=pose(sourceTime,[ctx.canvas.width,ctx.canvas.height],t);if(!p)return null;
      const tex=texture?pixels(texture):null;
      ctx.save();ctx.setTransform(1,0,0,1,0,0);
      if(shadow){ctx.save();ctx.filter='blur(9px)';ctx.translate(5,8);polygon(ctx,p.silhouette);ctx.fillStyle='rgba(12,20,24,.18)';ctx.fill();ctx.restore();}
      for(const face of p.faces){
        if(onlyFace&&face.name!==onlyFace)continue;
        const uv=options.uv?.[face.name];
        if(!tex||!uv){polygon(ctx,face.corners);const k=Math.round(190*face.shade);ctx.fillStyle=`rgb(${k},${k},${k})`;ctx.fill();continue;}
        const [ox,oy,nx,ny]=uv;
        if(![ox,oy,nx,ny].every(Number.isInteger)||ox<0||oy<0||nx<1||ny<1||ox+nx>tex.w||oy+ny>tex.h)throw Error('纹理 UV 超出图片范围');
        for(let row=0;row<ny;row++)for(let col=0;col<nx;col++){
          const k=((oy+row)*tex.w+ox+col)*4;if(!tex.data[k+3])continue;
          // Project each texel from the 3D face. An affine bitmap quad would distort perspective.
          const points=[[col/nx,row/ny],[(col+1)/nx,row/ny],[(col+1)/nx,(row+1)/ny],[col/nx,(row+1)/ny]].map(([u,v])=>p.project(face.at(u,v)));
          const center=mul(points.reduce((a,b)=>add(a,b),[0,0]),.25);
          polygon(ctx,points.map(q=>add(q,mul(unit(sub(q,center)),.35))));
          ctx.fillStyle=`rgba(${[0,1,2].map(i=>Math.round(tex.data[k+i]*face.shade)).join(',')},${tex.data[k+3]/255})`;ctx.fill();
        }
      }
      ctx.restore();return p;
    }
    const actor={pose,draw,options,kind:'cuboid'};bindings.push(actor);return actor;
  }
  function bindHand({hand='hand',calibrationTime,atlas,size=atlas?.size??[4,4,12],roll,twistWeight=1,widthScale=1.2,pose='auto',...options}={}){
    if(!track.motion)throw Error('需要重新 track_subject 获取掌面绑定运行时');
    if(!(widthScale>=.8&&widthScale<=1.8))throw Error('手臂宽度必须相对观测掌宽校准');
    if(options.depthRatio!==undefined&&!Number.isFinite(options.depthRatio))throw Error('手臂校准的深度比例约束需要固定数值');
    const palm=track.motion.palmBinding({hand,calibrationTime,endpoint:options.endpoint??'knuckles',extension:options.extension??1.15});
    const ref3D=track.motion.hand3D?.(calibrationTime,hand);
    if(pose==='3d'&&!ref3D)throw Error('校准帧没有通过质量检查的三维手姿，不得以二维转腕冒充');
    if(ref3D&&pose!=='2d')return bindEstimatedHand({hand,calibrationTime,atlas,size,roll:roll??0,widthScale,palm,ref3D,options});
    const actor=bindCuboid({...options,atlas,size,calibrationTime,start:t=>palm.at(t)?.start??null,end:t=>palm.at(t)?.end??null,roll:t=>(roll??25)+(palm.at(t)?.twist??0)*180/Math.PI*twistWeight});
    const targetSpan=palm.reference.span*widthScale;let best=null;
    for(let i=0;i<=190;i++){
      const ratio=options.depthRatio??(.25+i*.005);actor.options.depthRatio=ratio;
      const p=actor.pose(calibrationTime);if(!p)continue;
      const error=Math.abs(p.capSpan/targetSpan-1),score=error+Math.abs(ratio-.72)*.0001;
      if(!best||score<best.score)best={ratio,error,score,projectedSpan:p.capSpan};
      if(options.depthRatio!==undefined)break;
    }
    if(!best)throw Error('当前校准点无法构造有效三维手臂');
    actor.options.depthRatio=best.ratio;
    Object.assign(actor,{kind:'palm-rigid',palm,hand,calibration:{...best,targetSpan,widthScale,rootSource:palm.reference.rootSource,endpoint:palm.reference.endpoint,method:'knuckle-center-and-observed-span'}});return actor;
  }
  function bindEstimatedHand({hand,calibrationTime,atlas,size,roll,widthScale,palm,ref3D,options}){
    if(options.depthRatio!==undefined)throw Error('三维估计绑定不能用固定 depthRatio 覆盖观测');
    const refSpan=Math.hypot(...sub(ref3D.camera.indexMCP,ref3D.camera.littleMCP)),fov=ref3D.fov,f=track.size[0]/(2*Math.tan(fov*Math.PI/360));
    let physicalWidth=refSpan*widthScale;
    const frames=new Map();
    const observation=t=>{
      if(frames.has(t))return frames.get(t);
      const measured=track.motion.hand3D(t,hand),fit=palm.at(t);if(!measured||!fit)return null;
      const span=Math.hypot(...sub(measured.camera.indexMCP,measured.camera.littleMCP)),factor=refSpan/span;
      if(!(factor>.65&&factor<1.5))return null;
      const joints=Object.fromEntries(Object.entries(measured.camera).map(([k,v])=>[k,mul(v,factor)]));
      const endPixel=['indexMCP','middleMCP','littleMCP'].map(k=>track.motion.point(t,hand+'.'+k));if(endPixel.some(p=>!p))return null;
      const end=[0,1].map(i=>endPixel.reduce((s,p)=>s+p[i],0)/3),z=['indexMCP','middleMCP','littleMCP'].reduce((s,k)=>s+joints[k][2],0)/3;
      const lift=(p,z)=>[(p[0]-track.size[0]/2)/f*z,(p[1]-track.size[1]/2)/f*z,z];
      let root=fit.start.map((v,i)=>v*track.size[i]);
      const edge=track.at(t)?.support?.edgeAnchor;
      if(track.kind==='hand'&&edge){const p=edge.map((v,i)=>v*track.size[i]),d=unit(sub(p,fit.wrist)),dist=Math.min(...d.map((v,i)=>v<0?-fit.wrist[i]/v:v>0?(track.size[i]-fit.wrist[i])/v:Infinity));root=add(fit.wrist,mul(d,dist+fit.span*.45));}
      const result={end:lift(end,z),rootPixel:root,endPixel:end,across:unit(sub(joints.indexMCP,joints.littleMCP)),longitudinal:unit(sub(lift(end,z),lift(fit.wrist,joints.wrist[2]))),measured};
      frames.set(t,result);return result;
    };
    const geometry=t=>{
      const p=observation(t);if(!p)return null;
      const ray=[(p.rootPixel[0]-track.size[0]/2)/f,(p.rootPixel[1]-track.size[1]/2)/f,1],length=physicalWidth*size[2]/size[0];
      const aa=dot(ray,ray),bb=-2*dot(ray,p.end),cc=dot(p.end,p.end)-length*length,discriminant=bb*bb-4*aa*cc;
      if(discriminant<0)return null;
      const expected=p.end[2]-p.longitudinal[2]*length;
      const roots=[(-bb+Math.sqrt(discriminant))/(2*aa),(-bb-Math.sqrt(discriminant))/(2*aa)].filter(z=>z>.04).sort((a,b)=>Math.abs(a-expected)-Math.abs(b-expected));
      if(!roots.length)return null;
      const units=size[0]/physicalWidth;return {start:mul(ray,roots[0]*units),end:mul(p.end,units),across:p.across};
    };
    const actor=bindCuboid({...options,atlas,size,fov,roll,frame3D:geometry,start:t=>observation(t)?.rootPixel.map((v,i)=>v/track.size[i]),end:t=>observation(t)?.endPixel.map((v,i)=>v/track.size[i])});
    const targetSpan=palm.reference.span*widthScale;let best=null;
    for(let i=0;i<=100;i++){physicalWidth=refSpan*(.6+i*.015);const p=actor.pose(calibrationTime);if(!p)continue;const error=Math.abs(p.capSpan/targetSpan-1);if(!best||error<best.error)best={physicalWidth,error,projectedSpan:p.capSpan};}
    if(!best)throw Error('三维手姿与观测前臂无法形成一致几何');physicalWidth=best.physicalWidth;
    Object.assign(actor,{kind:'hand-pose-3d',palm,hand,calibration:{...best,targetSpan,widthScale,rootSource:palm.reference.rootSource,endpoint:'knuckles',method:'neural-depth-and-palm-normal',depthKind:ref3D.kind,model:ref3D.model,fov,metricScaleMeasured:false}});return actor;
  }
  function pixelWave(t,{start,duration,origin,end,cell=12,space='screen',scale=1},width,height) {
    if(!Number.isFinite(start)||!(duration>0)||!(cell>=2&&cell<=128))throw Error('像素转场时间或格子尺寸无效');
    const progress=smooth((t-start)/duration), direction=unit(sub(end,origin)),length=Math.max(cell,Math.hypot(...sub(end,origin)));
    const cells=[];
    if(progress>0&&progress<1&&space==='limb'){
      const step=cell*clamp(scale,.2,5),normal=[-direction[1],direction[0]],corners=[[0,0],[width,0],[width,height],[0,height]].map(p=>sub(p,origin));
      const us=corners.map(p=>dot(p,normal)/step),vs=corners.map(p=>dot(p,direction)/step);
      for(let v=Math.floor(Math.min(...vs))-1;v<=Math.ceil(Math.max(...vs))+1;v++)for(let u=Math.floor(Math.min(...us))-1;u<=Math.ceil(Math.max(...us))+1;u++){
        const seed=u*179+v*104729,threshold=((v+.5)*step+(hash(seed)-.5)*step*2.4)/length;
        const coverage=clamp((progress-threshold)*length/(step*.7)+.5);
        const edge=clamp(1-Math.abs(progress-threshold)*length/(step*.85));
        if(!coverage&&!edge)continue;
        const at=(x,y)=>add(origin,add(mul(normal,x*step),mul(direction,y*step)));
        cells.push({u,v,seed,corners:[[u,v],[u+1.025,v],[u+1.025,v+1.025],[u,v+1.025]].map(([x,y])=>at(x,y)),coverage,edge,replaced:coverage>.5});
      }
    }else if(progress>0&&progress<1){for(let y=0;y<height;y+=cell)for(let x=0;x<width;x+=cell){
      const distance=dot(sub([x+cell/2,y+cell/2],origin),direction);
      const threshold=distance/length+(hash(x/cell+Math.ceil(width/cell)*y/cell)-.5)*cell/length;
      cells.push({x,y,replaced:threshold<=progress,edge:Math.abs(threshold-progress)<cell*1.8/length});
    }}
    return {progress,origin,end,direction,length,cell,space,cells};
  }
  function particles(t,{start,duration,count=64},poseAt) {
    const result=[];
    for(let k=0;k<count;k++){
      const born=start+hash(k+31)*duration,age=t-born,life=.22+hash(k+88)*.35;
      if(age<0||age>life)continue;
      const p=poseAt(born);if(!p)continue;
      const direction=unit(sub(p.start,p.end)),normal=[-direction[1],direction[0]],length=norm2(sub(p.start,p.end));
      const center=add(p.end,mul(direction,smooth((born-start)/duration)*length));
      const origin=add(center,mul(normal,(hash(k+103)-.5)*p.width));
      const drift=age*(25+hash(k)*70),position=add(origin,add(mul(normal,drift*(hash(k+5)-.5)),[0,-age*65]));
      result.push({id:k,born,origin,position,size:(3+hash(k+2)*6)*(1-age/life),alpha:(1-age/life)*.9});
    }
    return result;
  }
  const norm2=a=>Math.hypot(...a);
  function replacement({actor,actors=actor?[actor]:[],part='subject',region='limb',margin=6,transition,foreground=[]}) {
    if(!actors.length||!transition)throw Error('主体替换需要绑定模型和转场配置');
    if(transition.direction&&!['to-root','from-root'].includes(transition.direction))throw Error('像素转场方向无效');
    const event=transition.event;
    if(event){if(!track.motion?.isConfirmation(event))throw Error('变身事件必须来自 motion.selector 的目标命中确认');if((transition.delay??0)<0)throw Error('不能在确认反馈展示完成之前启动变身');transition={...transition,start:event.feedback.readyAt+(transition.delay??0)};}
    const receipt={actors,event,transition,background:null,foreground:foreground.map(x=>x.part),waveSpace:'limb',particleSpace:'fixed-birth-pose',warnings:[]};replacements.push(receipt);
    let buffers;
    function prepare(w,h){if(!buffers||buffers.mask.width!==w||buffers.mask.height!==h){buffers=Object.fromEntries(['inverse','mask','expanded','next','wave','band','area'].map(k=>[k,canvas(w,h)]));}for(const c of Object.values(buffers)){const g=c.getContext('2d');g.setTransform(1,0,0,1,0,0);g.globalAlpha=1;g.globalCompositeOperation='source-over';g.filter='none';g.clearRect(0,0,w,h);}return buffers;}
    async function draw(ctx,t,{clean,background,behind,texture,source,sourceTime=t,sourceTimeAt=tt=>Math.min(tt,track.duration-1/30)}={}) {
      const w=ctx.canvas.width,h=ctx.canvas.height;
      ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,w,h);
      try {
        if(behind)ctx.drawImage(behind,0,0,w,h);
        await track.occlude(ctx,sourceTime,part);
        const poses=actors.map(a=>a.pose(sourceTime,[w,h],t));
        if(t<=transition.start)return {state:'original',progress:0};
        if(poses.some(p=>!p))return {state:'tracking-unavailable',progress:0};
        if(!track.at(sourceTime)?.matte)return {state:'mask-unavailable',progress:0};
        if(background){clean=await background.frame(sourceTime,w,h);receipt.background=background.summary;}
        if(!clean)throw Error('主体替换必须提供从本轮原片制作的干净背景');
        const wavePose=(st,clock=t)=>{
          const p=actors[0].pose(st,[w,h],clock);if(!p)return null;
          const direction=unit(sub(p.start,p.end)),pointer=actors[0].palm?.at(st)?.pointer?.map((v,i)=>v*[w,h][i]/track.size[i]);
          const extrema=p.silhouette.concat(pointer?[pointer]:[]).map(q=>dot(sub(q,p.end),direction));
          const tip=add(p.end,mul(direction,Math.min(0,...extrema))),origin=transition.origin?sample(st,transition.origin):null,end=transition.end?sample(st,transition.end):null;
          if(transition.direction==='from-root')return {...p,end:p.start,start:tip};
          return {...p,end:origin?[origin[0]*w,origin[1]*h]:tip,start:end?[end[0]*w,end[1]*h]:p.start};
        };
        const activeWave=wavePose(sourceTime),rest=wavePose(actors[0].palm?.calibrationTime??0,actors[0].palm?.calibrationTime??0);
        const wave=pixelWave(t,{...transition,space:'limb',scale:rest?norm2(sub(activeWave.start,activeWave.end))/norm2(sub(rest.start,rest.end)):1,origin:activeWave.end,end:activeWave.start},w,h);
        const b=prepare(w,h),ig=b.inverse.getContext('2d'),mg=b.mask.getContext('2d'),eg=b.expanded.getContext('2d');
        ig.fillStyle='white';ig.fillRect(0,0,w,h);await track.occlude(ig,sourceTime,part);
        // Complement alpha with Porter-Duff, never RGB inversion (which leaves opaque white holes).
        mg.fillStyle='white';mg.fillRect(0,0,w,h);mg.globalCompositeOperation='destination-out';mg.drawImage(b.inverse,0,0);mg.globalCompositeOperation='source-over';
        if(region==='limb'){
          const points=poses.flatMap(p=>p.silhouette);
          const hands=track.at(sourceTime)?.hands??{};
          const selected=new Set();
          for(const a of actors)if(a.hand){if(a.hand==='hand'){const key=Object.keys(hands)[0];if(key)selected.add(key);}else selected.add(a.hand);}
          for(const a of actors)for(const anchor of [a.options?.start,a.options?.end]){
            if(typeof anchor!=='string')continue;
            if(anchor.startsWith('hand.')){const key=Object.keys(hands)[0];if(key)selected.add(key);}
            else if(/^left(?:\.|[A-Z])/u.test(anchor))selected.add('left');
            else if(/^right(?:\.|[A-Z])/u.test(anchor))selected.add('right');
          }
          let palmWidth=0;
          for(const side of selected){
            const joints=hands[side];if(!joints)continue;
            const index=joints.indexMCP,little=joints.littleMCP;
            const span=index&&little?Math.hypot((index[0]-little[0])*w,(index[1]-little[1])*h):poses[0].width;
            palmWidth=Math.max(palmWidth,span);
            // Joints are inside the skin: include the palm/finger envelope BEFORE intersecting
            // with the real subject matte. A hull of joint centres cuts off the knuckles.
            for(const [name,q] of Object.entries(joints))if(q[2]>=.18){
              const radius=Math.max(6,span*(/Tip$/u.test(name)?.15:.32));
              for(let k=0;k<8;k++){const a=k*Math.PI/4;points.push([q[0]*w+Math.cos(a)*radius,q[1]*h+Math.sin(a)*radius]);}
            }
          }
          // Include the original sleeve around the bound limb, without erasing unrelated people/background.
          for(const p of poses){const d=unit(sub(p.end,p.start)),n=[-d[1],d[0]],radius=Math.max(p.width*.9,palmWidth*1.2,24);points.push(add(p.start,mul(n,radius)),sub(p.start,mul(n,radius)));}
          const ag=b.area.getContext('2d');polygon(ag,hull(points));ag.fillStyle='white';ag.fill();mg.globalCompositeOperation='destination-in';mg.drawImage(b.area,0,0);mg.globalCompositeOperation='source-over';
        }
        const r=clamp(margin,0,24);eg.filter='blur(2px)';for(const [x,y] of [[0,0],[-r,0],[r,0],[0,-r],[0,r],[-r*.7,-r*.7],[-r*.7,r*.7],[r*.7,-r*.7],[r*.7,r*.7]])eg.drawImage(b.mask,x,y);eg.filter='none';
        const ng=b.next.getContext('2d');ng.drawImage(clean,0,0,w,h);if(behind)ng.drawImage(behind,0,0,w,h);
        ng.globalCompositeOperation='destination-in';ng.drawImage(b.expanded,0,0);ng.globalCompositeOperation='source-over';
        // Shared ordering across limbs as well as within a cuboid. Explicit depth constraints
        // are still estimates; visible original foreground is restored separately below.
        if(actors.every(a=>a.pose(sourceTime,[w,h],t)?.faces)){
          const faces=actors.flatMap((a,i)=>poses[i].faces.map(f=>({a,f}))).sort((a,b)=>b.f.depth-a.f.depth);
          for(const {a,f} of faces)a.draw(ng,t,{texture,sourceTime,onlyFace:f.name,shadow:false});
        }else for(const a of actors)a.draw(ng,t,{texture,sourceTime});
        const wg=b.wave.getContext('2d'),bg=b.band.getContext('2d');wg.fillStyle=bg.fillStyle='white';
        if(wave.progress>=1)wg.fillRect(0,0,w,h);
        else for(const c of wave.cells){if(c.coverage){wg.globalAlpha=c.coverage;polygon(wg,c.corners);wg.fill();}if(c.edge){bg.globalAlpha=c.edge;polygon(bg,c.corners);bg.fill();}}wg.globalAlpha=bg.globalAlpha=1;
        bg.globalCompositeOperation='destination-in';bg.drawImage(b.next,0,0);bg.globalCompositeOperation='source-in';bg.fillStyle=transition.color??'#c5ff97';bg.fillRect(0,0,w,h);bg.globalCompositeOperation='source-over';
        ng.globalCompositeOperation='destination-in';ng.drawImage(b.wave,0,0);ng.globalCompositeOperation='source-over';
        // New clean background + restored UI and model replace the old hand under the SAME wave.
        eg.globalCompositeOperation='destination-in';eg.drawImage(b.wave,0,0);eg.globalCompositeOperation='source-over';
        ctx.globalCompositeOperation='destination-out';ctx.drawImage(b.expanded,0,0);ctx.globalCompositeOperation='source-over';ctx.drawImage(b.next,0,0);
        if(wave.progress>0&&wave.progress<1){ctx.save();ctx.globalAlpha=.5;ctx.filter='blur(6px)';ctx.drawImage(b.band,0,0);ctx.filter='none';ctx.globalAlpha=.4;ctx.drawImage(b.band,0,0);ctx.restore();
          for(const p of particles(t,transition,born=>wavePose(sourceTimeAt(born),born))){const [x,y]=p.position,s=p.size;ctx.save();ctx.globalAlpha=p.alpha;ctx.fillStyle=transition.color??'#c5ff97';ctx.fillRect(x,y,s,s);ctx.fillStyle='#4eab83';ctx.fillRect(x+s,y+s*.3,s*.4,s);ctx.restore();}
        }
        for(const layer of foreground){
          const visible=typeof layer.when==='function'?layer.when(sourceTime):layer.when!==false;if(!visible)continue;
          const original=layer.source??source;if(!original)throw Error('前景遮挡恢复需要原片当前帧 source');
          const fg=b.area.getContext('2d'),mask=b.inverse.getContext('2d');mask.clearRect(0,0,w,h);mask.fillStyle='white';mask.fillRect(0,0,w,h);
          const valid=await track.occlude(mask,sourceTime,layer.part);if(!valid)continue;
          fg.clearRect(0,0,w,h);fg.globalCompositeOperation='source-over';fg.drawImage(original,0,0,w,h);fg.globalCompositeOperation='destination-out';fg.drawImage(b.inverse,0,0);fg.globalCompositeOperation='source-over';ctx.drawImage(b.area,0,0);
        }
        return {state:wave.progress===1?'replaced':'transition',progress:wave.progress,poses:poses.map(p=>({start:p.start,end:p.end,depth:p.depth,rotation:p.rotation}))};
      } finally {ctx.restore();}
    }
    return {draw};
  }
  function audit(){
    const issues=[],checks=[];
    for(const replacement of replacements){
      if(!replacement.event)issues.push('变身使用固定时间，未绑定目标命中事件');
      if(replacement.event&&replacement.transition.start<=replacement.event.time)issues.push('变身未晚于确认事件');
      if(replacement.event&&replacement.transition.start<replacement.event.feedback.readyAt)issues.push('确认卡尚未完整显示并停留，变身已启动');
      if(!replacement.background)issues.push('未使用可追溯、逐帧配准的背景回填');
      else if(replacement.background.status!=='pass')issues.push('背景回填存在未通过的质量项');
      for(const actor of replacement.actors){
        const rows=[];for(let t=replacement.transition.start;t<track.duration;t+=1/30){const p=actor.pose(t);rows.push({t,p,fit:actor.palm?.at(t)});}
        const valid=rows.filter(r=>r.p),clipped=actor.kind==='hand-pose-3d'?0:valid.filter(r=>r.fit?.twistClamped).length;
        if(valid.length<rows.length*.95)issues.push('变身段有效姿态不足95%');
        if(actor.kind!=='palm-rigid'&&typeof actor.options?.end==='string'&&/Tip$/u.test(actor.options.end))issues.push('整臂直接绑定活动指尖，可能将弯指误作整臂缩放');
        if(clipped)issues.push('转腕达到限制值，需要检查校准姿态');
        if(actor.calibration?.error>.12)issues.push('三维截面与观测掌宽的校准误差超过12%');
        if(actor.palm?.reference.endpoint?.endsWith('Tip'))issues.push('方块末端仍在校准指尖，未与掌骨截面区分');
        if(actor.calibration?.rootSource==='palm-ray-fallback')issues.push('手臂入画点未得到可见肘部或原始轮廓边界支持');
        const size=actor.options?.size??[4,4,12],uv=actor.options?.uv?.front;
        if(uv&&Math.abs(size[2]/size[0]/(uv[3]/uv[2])-1)>.12)issues.push('侧面UV与几何比例相差超过12%');
        const atlas=actor.options?.atlas;
        if(atlas?.kind==='box-net'&&['start','end'].some(face=>JSON.stringify(actor.options.uv?.[face])!==JSON.stringify(atlas.uv[face])))issues.push('方块展开贴图的近端/末端面被手动调换');
        checks.push({kind:actor.kind,calibration:actor.calibration,continuation:actor.options?.motion?{kind:'authored-model-motion',keyframes:actor.options.motion}:null,waveDirection:replacement.transition.direction??'to-root',waveSpace:replacement.waveSpace,particleSpace:replacement.particleSpace,samples:rows.length,valid:valid.length,twistClamped:clipped,depthRatios:valid.map(r=>r.p.depth.near/r.p.depth.far),rollDegrees:valid.length?[Math.min(...valid.map(r=>r.p.rotation))*180/Math.PI,Math.max(...valid.map(r=>r.p.rotation))*180/Math.PI]:[],event:replacement.event?{time:replacement.event.time,target:replacement.event.target,evidence:replacement.event.evidence,feedback:replacement.event.feedback,transformStart:replacement.transition.start}:null,background:replacement.background});
      }
    }
    return {version:4,applicable:replacements.length>0,status:issues.length?'fail':'pass',issues:[...new Set(issues)],checks,limitations:['三维手姿为单目估计，焦距及体型尺度不是测量值','未见肘部的前臂深度方向使用掌面先验与轮廓约束','复杂前后遮挡需要明确的前景部位及层次','机械检查不能替代实际成片视觉复核']};
  }
  return {bindCuboid,bindHand,cuboidAtlas,replacement,pixelWave,particles,sample,audit,version:4};
}
