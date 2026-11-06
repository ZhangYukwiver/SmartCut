// Self-contained so the same controller and renderer travel with exported tracks.
export function subjectCarousel({track,point,gestures,selector}, options={}) {
  const {items:inputItems,viewport:inputViewport,center:inputCenter,card:inputCard=[220,330],spacing=360,initialIndex=0,start=0,end=track.duration,browseUntil=end,
    hand='hand',gain=1,snapDuration=.12,fps=30,requiredDirections=[]}=options;
  const finite=a=>Array.isArray(a)&&a.every(Number.isFinite);
  if(!Array.isArray(inputItems)||inputItems.length<2||inputItems.some(x=>!x.id)||new Set(inputItems.map(x=>x.id)).size!==inputItems.length)
    throw Error('轮播需要至少两个不同 id 的封面');
  if(!finite(inputViewport)||inputViewport.length!==4||inputViewport[2]<=0||inputViewport[3]<=0||!finite(inputCenter)||inputCenter.length!==2||!finite(inputCard)||inputCard.length!==2||inputCard.some(x=>x<=0)
    ||!Number.isFinite(spacing)||spacing<inputCard[0]||!Number.isInteger(initialIndex)||initialIndex<0||initialIndex>=inputItems.length
    ||!(start>=0&&end>start&&end<=track.duration&&browseUntil>start&&browseUntil<=end)||!(gain>=.5&&gain<=2)||!(snapDuration>=.08&&snapDuration<=.5)||!(fps>=15&&fps<=60))
    throw Error('轮播布局、时间或跟随参数无效（坐标使用原片像素）');
  const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
  const items=freeze(inputItems.map(({id,label})=>({id,label}))),viewport=freeze([...inputViewport]),center=freeze([...inputCenter]),card=freeze([...inputCard]);
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x)),mod=i=>(i%items.length+items.length)%items.length;
  const inside=p=>p&&p[0]>=viewport[0]&&p[0]<=viewport[0]+viewport[2]&&p[1]>=viewport[1]-card[1]*.3&&p[1]<=viewport[1]+viewport[3];
  const rows=[];
  // Browsing may stop before a later press. It must not shorten press detection,
  // or require the page to mutate drags after focus/confirmation were computed.
  for(let n=Math.floor(start*fps);n/fps<=browseUntil;n++) {
    const t=n/fps,p=point(t,hand+'.indexTip'),confidence=track.point(t,hand+'.indexTip')?.[2]??0;
    const a=point(t,hand+'.indexMCP'),b=point(t,hand+'.littleMCP');
    rows.push({time:t,point:confidence>=.55?p:null,span:a&&b?Math.hypot(a[0]-b[0],a[1]-b[1]):card[0]});
  }
  const drags=[];let run=null;
  function finish(){
    if(run&&run.end-run.start>=.10&&Math.abs(run.dx)>=Math.max(60,run.span*.4))drags.push(run);
    run=null;
  }
  // Capture horizontal motion, including a flexed finger. The old swipe detector's
  // extended-finger gate discarded a large reverse drag in real footage.
  for(let i=1;i<rows.length-1;i++) {
    const a=rows[i-1],c=rows[i],b=rows[i+1];
    if(!a.point||!b.point||!c.point){finish();continue;}
    const dx=b.point[0]-a.point[0],dy=b.point[1]-a.point[1],dt=b.time-a.time;
    const moving=Math.abs(dx/dt)>Math.max(140,c.span*.7)&&Math.abs(dx)>Math.abs(dy)*.9;
    if(!moving){finish();continue;}
    if(run&&Math.sign(run.dx)!==Math.sign(dx))finish();
    if(!run&&inside(a.point))run={start:a.time,end:b.time,from:a.point,to:b.point,dx,span:c.span,type:'swipe',evidence:'measured-pointer-trajectory'};
    else if(run)Object.assign(run,{end:b.time,to:b.point,dx:b.point[0]-run.from[0]});
  }
  finish();
  // A one-frame horizontal slowdown must not create two independent snaps.
  for(let i=1;i<drags.length;i++) {
    const a=drags[i-1],b=drags[i];
    if(b.start-a.end<=2/fps+1e-6&&Math.sign(a.dx)===Math.sign(b.dx)){
      Object.assign(a,{end:b.end,to:b.to,dx:b.to[0]-a.from[0]});drags.splice(i--,1);
    }
  }
  const smooth=x=>x*x*(3-2*x);
  function stateAt(t) {
    let position=initialIndex,phase='idle',active=null;
    for(const d of drags){
      if(t<d.start)break;
      if(t<=d.end){const p=point(t,hand+'.indexTip');position=d.position-(p?p[0]-d.from[0]:0)*gain/spacing;phase=p?'dragging':'lost';active=d;break;}
      const u=clamp((t-d.end)/snapDuration,0,1);position=d.release+(d.target-d.release)*smooth(u);phase=u<1?'settling':'idle';active=d;
    }
    return {position,phase,active};
  }
  for(const d of drags){const prior=stateAt(d.start-1e-7);d.position=prior.position;d.release=d.position-d.dx*gain/spacing;d.target=Math.round(d.release);d.direction=d.dx>0?'right':'left';}
  freeze(drags);
  // Precompute hysteresis in source-time order. Seeking backwards never retains a
  // highlight from a later frame; lifting the pointer never clears the focus.
  let focus=initialIndex;const focuses=[];
  for(let n=Math.floor(start*fps);n/fps<=end+snapDuration+1/fps;n++){
    const state=stateAt(n/fps);
    if(state.phase==='dragging'){if(Math.abs(state.position-focus)>.6)focus=Math.round(state.position);}
    else focus=state.active?.target??initialIndex;
    focuses.push({time:n/fps,index:focus});
  }
  function raw(t){const state=stateAt(t);let index=initialIndex;for(const f of focuses){if(f.time>t+1e-7)break;index=f.index;}return {...state,index,selected:items[mod(index)].id};}
  function layout(t,state=raw(t)) {
    const cards=[],radius=Math.ceil(viewport[2]/spacing/2)+1;
    for(let j=Math.floor(state.position)-radius;j<=Math.ceil(state.position)+radius;j++){
      const d=j-state.position,weight=Math.exp(-d*d*2),scale=.86+.14*weight,w=card[0]*scale,h=card[1]*scale;
      const x=center[0]+d*spacing-w/2,y=center[1]-h/2;
      if(x+w<viewport[0]||x>viewport[0]+viewport[2])continue;
      cards.push({id:items[mod(j)].id,index:j,rect:[x,y,w,h],selected:j===state.index,weight});
    }
    return cards;
  }
  const original=gestures({hand,start,end,fps});
  const targets=t=>{const s=raw(t);return s.phase==='idle'?layout(t,s).filter(c=>c.selected).map(c=>({id:c.id,rect:c.rect.map((v,i)=>v/track.size[i%2])})):[];};
  const selection=selector({hand,events:{...original,swipes:drags},targets,feedback:options.feedback??{enter:.24,hold:.25}});
  const confirmation=selection.events[0],feedbackAt=selection.at;
  // The carousel locks on its first accepted press. Later candidates must not
  // remain available as competing confirmation events for a replacement effect.
  selection.events.splice(1);
  function at(t){
    const state=raw(confirmation&&t>=confirmation.time?confirmation.time:t),feedback=feedbackAt(t),selectedIndex=mod(state.index);
    return freeze({...state,selectedIndex,item:items[selectedIndex],phase:feedback.confirmed?'confirmed':state.phase,confirmed:feedback.confirmed,event:feedback.event,feedbackOpacity:feedback.feedbackOpacity,ready:feedback.ready,cards:layout(t,state)});
  }
  // Keep the selector registered with subjectMotion, including its confirmed
  // event identity, but expose the carousel's persistent focus through every API.
  selection.at=at;freeze(selection);
  const rendered=new Map();
  function draw(ctx,t,{images,labels={},font='"PingFang SC","Microsoft YaHei",sans-serif',opacity=1,showLabel=true}={}){
    const state=at(t);if(t<start)return state;
    if(!ctx||typeof ctx.drawImage!=='function'||!images)throw Error('轮播绘制需要真实画布及已解码封面');
    const visibleOpacity=ctx.globalAlpha*clamp(opacity,0,1);
    ctx.save();ctx.globalAlpha=visibleOpacity;ctx.beginPath();ctx.rect(...viewport);ctx.clip();
    for(const c of state.cards){
      const image=images[c.id],iw=image?.naturalWidth??image?.width,ih=image?.naturalHeight??image?.height;
      if(!(iw>0&&ih>0)){ctx.restore();throw Error('轮播封面未解码：'+c.id);}
      const [x,y,w,h]=c.rect,scale=Math.max(w/iw,h/ih),sw=w/scale,sh=h/scale;
      if(c.selected){ctx.fillStyle='#062b36';ctx.fillRect(x-11,y-11,w+22,h+22);}
      ctx.fillStyle=c.selected?'#b6ffec':'#4d8794';ctx.fillRect(x-4,y-4,w+8,h+8);
      ctx.drawImage(image,(iw-sw)/2,(ih-sh)/2,sw,sh,x,y,w,h);
      ctx.fillStyle=`rgba(4,24,34,${.28*(1-c.weight)})`;ctx.fillRect(x,y,w,h);
      if(c.selected){
        // Bright covers and a foreground fingertip can hide a thin outline.
        // Identical corner markers keep every selected game's contrast consistent.
        ctx.fillStyle='#c5ffea';
        for(const [cx,cy,sx,sy] of [[x-8,y-8,1,1],[x+w+8,y-8,-1,1],[x-8,y+h+8,1,-1],[x+w+8,y+h+8,-1,-1]]){
          ctx.fillRect(cx+(sx<0?-25:0),cy+(sy<0?-5:0),25,5);
          ctx.fillRect(cx+(sx<0?-5:0),cy+(sy<0?-25:0),5,25);
        }
      }
    }
    // The viewport may intentionally crop side posters. Keep the current game's
    // name in a fixed, fully readable slot instead of clipping moving captions.
    if(showLabel){
      const labelY=viewport[1]+viewport[3]-12;
      ctx.fillStyle='rgba(3,31,40,.94)';ctx.fillRect(center[0]-170,labelY-27,340,37);
      ctx.fillStyle='#b6ffec';ctx.fillRect(center[0]-170,labelY+8,340,2);
      ctx.fillStyle='#e0fff7';ctx.textAlign='center';ctx.font=`600 23px ${font}`;
      const label=labels[state.selected]??state.item.label??state.selected;
      ctx.fillText(label+'  ·  '+String(state.selectedIndex+1).padStart(2,'0')+' / '+String(items.length).padStart(2,'0'),center[0],labelY);
    }
    ctx.restore();rendered.set(Math.round(t*fps),{time:t,...state,opacity:visibleOpacity});
    return state;
  }
  function audit(){
    const issues=[],checks=[],visible=[...rendered.values()].filter(r=>r.opacity>.95);
    const mismatches=visible.filter(r=>{
      const selected=r.cards.filter(c=>c.selected);
      return selected.length!==1||selected[0].id!==r.selected||r.item.id!==r.selected
        ||(['idle','confirmed'].includes(r.phase)&&Math.abs(r.position-r.index)>1e-6)
        ||(r.confirmed&&r.event?.target!==r.selected);
    });
    if(mismatches.length)issues.push('封面位置、高亮与点击确认的选中状态不一致');
    if(confirmation){
      const state=at(confirmation.time),card=state.cards.find(c=>c.selected);
      if(state.selected!==confirmation.target||!card||card.rect.some((v,i)=>Math.abs(v/track.size[i%2]-confirmation.rect[i])>1e-6))
        issues.push('点击确认目标不是实际选中封面');
    }
    for(const direction of requiredDirections)if(!drags.some(d=>d.direction===direction))issues.push('缺少'+direction+'方向的可测拖动');
    for(const d of drags){
      if(confirmation&&d.start>confirmation.time)continue;
      const samples=visible.filter(r=>r.time>=d.start-1e-6&&r.time<=d.end+1e-6);
      const expected=Math.floor((d.end-d.start)*fps);
      if(samples.length<Math.max(2,expected-1))issues.push('拖动区间缺少实际绘制帧');
      let maxError=0;
      for(const r of samples){const p=point(r.time,hand+'.indexTip');if(p)maxError=Math.max(maxError,Math.abs((d.position-r.position)*spacing-(p[0]-d.from[0])*gain));}
      if(maxError>1)issues.push('封面未按逐帧手指位移绘制');
      const next=drags.find(x=>x.start>d.end),settle=d.end+snapDuration;
      const idle=visible.filter(r=>r.time>=settle-1e-6&&r.time<(next?.start??confirmation?.time??end)+1e-6);
      const snapError=idle.length?Math.max(...idle.map(r=>Math.abs(r.position-d.target)*spacing)):null;
      if(snapError===null||snapError>.5)issues.push('释放后的卡位吸附缺少证据或未到位');
      if(idle.some(r=>r.selected!==items[mod(d.target)].id))issues.push('吸附后的选中高亮不稳定');
      checks.push({start:d.start,end:d.end,direction:d.direction,fingerDx:d.dx,coverDx:d.dx*gain,renderedFrames:samples.length,maxFollowErrorPx:maxError,snapErrorPx:snapError,selected:items[mod(d.target)].id});
    }
    if(!visible.length)issues.push('未调用原生轮播绘制，不能以控制器状态代替实际画面');
    return {kind:'gesture-carousel',applicable:true,status:issues.length?'fail':'pass',issues:[...new Set(issues)],checks,selection:{consistent:visible.length>0&&!mismatches.length,checkedFrames:visible.length,mismatchedFrames:mismatches.map(r=>r.time)},confirmation:confirmation?{time:confirmation.time,target:confirmation.target}:null,limitations:['机械检查验证绘制轨迹、方向、吸附与选中状态，不替代完整合成的遮挡和观感复核']};
  }
  return freeze({at,draw,audit,selection,drags,layout: t=>at(t).cards,targets,version:2});
}
