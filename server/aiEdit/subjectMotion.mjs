import {subjectCarousel} from './subjectCarousel.mjs';
// Exported with the track. All queries are deterministic, including backwards seeks.
export function subjectMotion(track,carouselFactory=subjectCarousel) {
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const sub=(a,b)=>a.map((v,i)=>v-b[i]),add=(a,b)=>a.map((v,i)=>v+b[i]),mul=(a,n)=>a.map(v=>v*n);
  const norm=a=>Math.hypot(...a),unit=a=>mul(a,1/(norm(a)||1));
  const mean=a=>a[0].map((_,i)=>a.reduce((s,p)=>s+p[i],0)/a.length);
  const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
  const confirmations=new WeakSet(),selections=[],carousels=[];
  const point=(t,key)=>{const p=track.point(t,key);if(!p)return null;const values=[[-1/30,.2],[0,.6],[1/30,.2]].map(([dt,w])=>[track.point(t+dt,key),w]).filter(([p])=>p);const weight=values.reduce((s,[,w])=>s+w,0);return [0,1].map(i=>values.reduce((s,[p,w])=>s+p[i]*w,0)/weight*track.size[i]);};
  function hand3D(t,hand='hand'){
    const get=tt=>{const frame=track.at?.(tt),side=hand==='hand'?Object.keys(frame?.hands??{})[0]:hand;return frame?.handPose3D?.[side];};
    let current=get(t);
    if(!current){
      // Only bridge a short, bracketed 3D-model rejection while the selected 2D
      // hand is still observed. Never extrapolate a lost hand or extend past EOF.
      if(!point(t,hand+'.wrist'))return null;
      let a,b;
      for(let n=1;n<=3;n++){if(!a&&get(t-n/30))a={pose:get(t-n/30),time:t-n/30};if(!b&&get(t+n/30))b={pose:get(t+n/30),time:t+n/30};}
      if(!a||!b||b.time-a.time>.101)return null;
      const u=(t-a.time)/(b.time-a.time),camera={};
      for(const k of Object.keys(a.pose.camera))camera[k]=a.pose.camera[k].map((v,i)=>v*(1-u)+b.pose.camera[k][i]*u);
      return {...a.pose,camera,temporalBridge:{from:a.time,to:b.time},confidence:Math.min(a.pose.confidence,b.pose.confidence)*.8};
    }
    const values=[[-2/30,.1],[-1/30,.2],[0,.4],[1/30,.2],[2/30,.1]].map(([dt,w])=>[get(t+dt),w]).filter(([p])=>p&&p.kind===current.kind);
    const total=values.reduce((s,[,w])=>s+w,0),camera={};
    for(const k of Object.keys(current.camera))camera[k]=[0,1,2].map(i=>values.reduce((s,[p,w])=>s+p.camera[k][i]*w,0)/total);
    return {...current,camera};
  }
  function palmBinding({hand='hand',calibrationTime,endpoint='knuckles',extension=1.12}={}) {
    if(!Number.isFinite(calibrationTime)||calibrationTime<0||calibrationTime>=track.duration)throw Error('手臂绑定需要原片内的校准时刻');
    const keys=['wrist','indexMCP','middleMCP','littleMCP'].map(k=>hand+'.'+k);
    const ref=keys.map(k=>point(calibrationTime,k));
    if(ref.some(p=>!p))throw Error('校准帧缺少可靠手腕或掌指关节，请选清晰帧');
    const target=endpoint==='knuckles'?mean(ref.slice(1)):point(calibrationTime,hand+'.'+endpoint);
    if(!target)throw Error('校准帧缺少末端参考点');
    const center=mean(ref),axis=unit(sub(target,ref[0]));
    // Extend the reference forearm beyond the frame. Subsequent poses transport BOTH ends
    // with the palm, rather than treating fingertip flexion as arm translation/depth.
    const distances=axis.map((v,i)=>Math.abs(v)<1e-5?Infinity:(target[i]-(v>0?0:track.size[i]))/v).filter(n=>n>0);
    let root=sub(target,mul(axis,Math.max(120,Math.min(...distances))*extension)),rootSource='palm-ray-fallback';
    const side=hand==='hand'?Object.keys(track.at?.(calibrationTime)?.hands??{})[0]:hand;
    const elbow=side?point(calibrationTime,side+'Elbow'):null;
    const support=track.at?.(calibrationTime)?.support,span=norm(sub(ref[1],ref[3]));
    if(elbow){root=elbow;rootSource='observed-body-elbow';}
    else if(track.kind==='hand'&&support?.edgeAnchor){
      const edge=support.edgeAnchor.map((v,i)=>v*track.size[i]),direction=unit(sub(edge,ref[0])),distance=norm(sub(edge,ref[0]));
      if(distance>span*.2&&distance<span*4){
        const edgeDistance=Math.min(...direction.map((v,i)=>v<0?-ref[0][i]/v:v>0?(track.size[i]-ref[0][i])/v:Infinity));
        root=add(ref[0],mul(direction,edgeDistance+span*.45));rootSource='observed-mask-frame-contact';
      }
    }
    const centered=ref.map(p=>sub(p,center)),denom=centered.reduce((s,p)=>s+p[0]*p[0]+p[1]*p[1],0);
    const palmAngle=p=>wrap(Math.atan2(p[3][1]-p[1][1],p[3][0]-p[1][0])-Math.atan2(p[2][1]-p[0][1],p[2][0]-p[0][0]));
    const restAngle=palmAngle(ref),cache=new Map();
    const pointer=point(calibrationTime,hand+'.indexTip')??target;
    function at(t){
      if(cache.has(t))return cache.get(t);
      const points=keys.map(k=>point(t,k));if(points.some(p=>!p))return null;
      const mid=mean(points),q=points.map(p=>sub(p,mid));let a=0,b=0;
      for(let i=0;i<4;i++){a+=centered[i][0]*q[i][0]+centered[i][1]*q[i][1];b+=centered[i][0]*q[i][1]-centered[i][1]*q[i][0];}a/=denom;b/=denom;
      const scale=Math.hypot(a,b),apply=p=>{const [x,y]=sub(p,center);return [mid[0]+a*x-b*y,mid[1]+b*x+a*y];};
      const residual=Math.sqrt(ref.reduce((s,p,i)=>s+norm(sub(apply(p),points[i]))**2,0)/4),palmSize=norm(sub(points[2],points[0]));
      if(!Number.isFinite(scale)||scale<.3||scale>3||residual>palmSize*.25)return null;
      const rawTwist=wrap(palmAngle(points)-restAngle),twist=clamp(rawTwist,-Math.PI/3,Math.PI/3);
      const currentRoot=elbow?point(t,side+'Elbow'):apply(root);if(!currentRoot)return null;
      const pose={start:currentRoot.map((v,i)=>v/track.size[i]),end:apply(target).map((v,i)=>v/track.size[i]),pointer:apply(pointer),wrist:points[0],scale,angle:Math.atan2(b,a),twist,twistClamped:Math.abs(rawTwist-twist)>1e-6,residual,palmSize,span:norm(sub(points[1],points[3]))};
      cache.set(t,pose);if(cache.size>150)cache.delete(cache.keys().next().value);return pose;
    }
    return {at,hand,calibrationTime,reference:{root,target,points:ref,span,rootSource,endpoint},kind:'palm-rigid'};
  }
  function gestures({hand='hand',start=0,end=track.duration,fps=30}={}){
    const rows=[];
    for(let n=Math.ceil(start*fps);n/fps<Math.min(end,track.duration);n++){
      const t=n/fps,tip=point(t,hand+'.indexTip'),mcp=point(t,hand+'.indexMCP'),little=point(t,hand+'.littleMCP'),wrist=point(t,hand+'.wrist');
      if(!tip||!mcp||!little||!wrist){rows.push({time:t});continue;}
      const span=norm(sub(mcp,little)),palm=mul(add(mcp,little),.5);
      rows.push({time:t,tip,palm,span,extended:norm(sub(tip,mcp))>span*.68,relative:sub(tip,palm),confidence:track.point(t,hand+'.indexTip')[2]});
    }
    const swipes=[];let run=null;
    for(let i=2;i<rows.length-2;i++){
      const a=rows[i-2],c=rows[i],b=rows[i+2];if(!a.tip||!b.tip||!c.tip){run=null;continue;}
      const d=sub(b.tip,a.tip),velocity=mul(d,1/(b.time-a.time));
      const moving=c.extended&&Math.abs(velocity[0])>Math.max(100,c.span*1.1)&&Math.abs(velocity[0])>Math.abs(velocity[1])*1.15;
      if(moving){if(!run||Math.sign(run.dx)!==Math.sign(d[0]))run={start:a.time,end:b.time,from:a.tip,to:b.tip,dx:d[0],span:c.span};else Object.assign(run,{end:b.time,to:b.tip,dx:b.tip[0]-run.from[0]});}
      else if(run){if(run.end-run.start>=.10&&Math.abs(run.dx)>run.span*.55)swipes.push({...run,type:'swipe',evidence:'measured-horizontal-displacement'});run=null;}
    }
    if(run&&Math.abs(run.dx)>run.span*.55)swipes.push({...run,type:'swipe',evidence:'measured-horizontal-displacement'});
    const presses=[];
    // A 2D dip-and-return is a candidate, NOT a claim of measured physical contact.
    // Confirmation additionally requires a target hit and a completed prior swipe.
    for(let i=4;i<rows.length-4;i++){
      const c=rows[i];if(!c.tip||!c.extended||c.confidence<.55)continue;
      const before=rows.slice(i-4,i).filter(p=>p.tip&&p.extended),after=rows.slice(i+1,i+5).filter(p=>p.tip&&p.extended);
      if(before.length<3||after.length<3)continue;
      const left=Math.min(...before.map(p=>p.relative[1])),right=Math.min(...after.map(p=>p.relative[1]));
      const amplitude=Math.min(c.relative[1]-left,c.relative[1]-right);
      if(amplitude<Math.max(5,c.span*.035)||[...before,...after].some(p=>p.relative[1]>c.relative[1]+.01))continue;
      if(presses.length&&c.time-presses.at(-1).time<.3)continue;
      presses.push({type:'press',time:c.time,point:c.tip.map((v,j)=>v/track.size[j]),confidence:c.confidence,amplitude,span:c.span,evidence:'finger-dip-return',status:'candidate'});
    }
    return {rows,swipes,presses,limitation:'二维弯指/回弹候选，不测量触屏深度；须命中目标才确认'};
  }
  function selector({targets,hand='hand',after,events=gestures({hand}),feedback={enter:.24,hold:.25}}={}){
    if(typeof targets!=='function'&&!Array.isArray(targets))throw Error('交互需要实际绘制的目标区域');
    if(!Number.isFinite(feedback.enter)||feedback.enter<0||!Number.isFinite(feedback.hold)||feedback.hold<.15)throw Error('确认反馈需要有效淡入时间和至少0.15秒完整展示');
    const get=t=>typeof targets==='function'?targets(t):targets;
    function hit(t,p){return get(t).find(x=>{const [a,b,w,h]=x.rect;return p[0]>=a&&p[0]<=a+w&&p[1]>=b&&p[1]<=b+h;})??null;}
    const since=after??events.swipes.at(-1)?.end??0;
    const confirmed=events.presses.filter(e=>e.time>=since).flatMap(e=>{const target=hit(e.time,e.point);if(!target)return [];const event={...e,target:target.id,rect:target.rect.slice(),status:'confirmed',feedback:{enter:feedback.enter,hold:feedback.hold,visibleAt:e.time+feedback.enter,readyAt:e.time+feedback.enter+feedback.hold}};confirmations.add(event);return [event];});
    const result={events:confirmed,at(t){const e=confirmed.find(x=>x.time<=t);if(e)return {selected:e.target,confirmed:true,event:e,feedbackOpacity:feedback.enter?clamp((t-e.time)/feedback.enter,0,1):1,ready:t>=e.feedback.readyAt};const p=point(t,hand+'.indexTip');return {selected:p?hit(t,p.map((v,i)=>v/track.size[i]))?.id??null:null,confirmed:false,feedbackOpacity:0,ready:false};}};
    selections.push(result);return result;
  }
  function carousel(options){const c=carouselFactory({track,point,gestures,selector},options);carousels.push(c);return c;}
  function audit(){const reports=carousels.map(c=>c.audit());return {kind:'gesture-carousel',applicable:reports.length>0,status:reports.some(r=>r.status!=='pass')?'fail':'pass',reports};}
  return {palmBinding,hand3D,gestures,selector,point,carousel,audit,isConfirmation:event=>confirmations.has(event),selections};
}
