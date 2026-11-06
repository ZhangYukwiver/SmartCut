// This function is serialized with each track. It must not depend on imports or the editor.
export function subjectPlayback(frames, size, speed, duration, base) {
  const images = new Map();
  function at(t) {
    if (!Number.isFinite(t) || t < 0 || t >= duration || !frames.length) return null;
    // The film host seeks 1 ms into the named source frame, including variable-rate video.
    const source = t * speed + 0.001;
    let lo = 0, hi = frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].time <= source) lo = mid + 1; else hi = mid;
    }
    return frames[lo - 1] ?? null;
  }
  function point(t, name, minConfidence = 0.25) {
    const frame = at(t);
    if (!frame) return null;
    const [part, joint] = name.split(".");
    const hand = part === "hand" ? Object.values(frame.hands)[0] : frame.hands[part];
    // Common anatomical spelling; Vision calls the same finger "little".
    const key = joint?.replace(/^pinky(?=MCP$|PIP$|DIP$|Tip$)/u,"little");
    const p = joint ? hand?.[key] : frame.body[part];
    return p && p[2] >= minConfidence ? p : null;
  }
  function bone(t, start, end, minConfidence = 0.25) {
    const a = point(t, start, minConfidence), b = point(t, end, minConfidence);
    if (!a || !b) return null;
    const dx = (b[0] - a[0]) * size[0], dy = (b[1] - a[1]) * size[1];
    return { start: a, end: b, angle: Math.atan2(dy, dx), length: Math.hypot(dx, dy) };
  }
  function image(name) {
    if (!images.has(name)) {
      images.set(name, new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("加载主体遮罩失败：" + name));
        img.src = new URL(name, base).href;
      }));
      if (images.size > 5) images.delete(images.keys().next().value);
    }
    return images.get(name);
  }
  // The subject silhouette supplies the outer edge. Within a person, restrict the mask
  // to the palm and individual finger bones, so that a shirt behind the hand stays visible.
  function handPath(path, joints, viewport, bodyWrist) {
    const [x,y,w,h] = viewport;
    const pos = name => {
      const p = joints[name];
      return p && p[2] >= 0.18 ? [x+p[0]*w, y+p[1]*h] : null;
    };
    const wrist = pos("wrist") ?? (bodyWrist?.[2]>=0.25 ? [x+w*bodyWrist[0],y+h*bodyWrist[1]] : null);
    const index = pos("indexMCP"), little = pos("littleMCP"), middle = pos("middleMCP");
    if (!wrist || !middle || (!index && !little)) return false;
    const palm = [wrist,pos("thumbCMC"),index,middle,pos("ringMCP"),little].filter(Boolean);
    if (palm.reduce((sum,p,i)=>{const q=palm[(i+1)%palm.length];return sum+p[0]*q[1]-q[0]*p[1];},0)>0) palm.reverse();
    const width = index && little ? Math.hypot(index[0]-little[0], index[1]-little[1]) : Math.hypot(wrist[0]-middle[0], wrist[1]-middle[1]);
    path.moveTo(...palm[0]);
    for (const p of palm.slice(1)) path.lineTo(...p);
    path.closePath();
    for (const prefix of ["thumb","index","middle","ring","little"]) {
      const names = prefix === "thumb" ? ["CMC","MP","IP","Tip"] : ["MCP","PIP","DIP","Tip"];
      for (let i=1; i<names.length; i++) {
        const a=pos(prefix+names[i-1]), b=pos(prefix+names[i]);
        if (!a || !b) continue;
        const dx=b[0]-a[0], dy=b[1]-a[1], len=Math.hypot(dx,dy) || 1;
        const radius=Math.max(1,width*(0.17-i*0.018)), nx=-dy/len*radius, ny=dx/len*radius;
        path.moveTo(a[0]+nx,a[1]+ny); path.lineTo(b[0]+nx,b[1]+ny);
        path.lineTo(b[0]-nx,b[1]-ny); path.lineTo(a[0]-nx,a[1]-ny); path.closePath();
        for (const p of [a,b]) { path.moveTo(p[0]+radius,p[1]); path.arc(p[0],p[1],radius,0,Math.PI*2,true); }
      }
    }
    return true;
  }
  function forearmPath(path, body, side, viewport) {
    const elbow=body[side+"Elbow"], wrist=body[side+"Wrist"], neck=body.neck, hip=body.root;
    if (![elbow,wrist,neck,hip].every(p=>p && p[2]>=0.2)) return false;
    const [x,y,w,h]=viewport, ex=x+elbow[0]*w, ey=y+elbow[1]*h, wx=x+wrist[0]*w, wy=y+wrist[1]*h;
    const length=Math.hypot(wx-ex,wy-ey);
    if (length<1) return false;
    const torso=Math.hypot((neck[0]-hip[0])*w,(neck[1]-hip[1])*h);
    const start=Math.max(1,torso*.115), end=Math.max(1,torso*.078);
    const nx=(ey-wy)/length, ny=(wx-ex)/length;
    path.moveTo(ex+nx*start,ey+ny*start); path.lineTo(wx+nx*end,wy+ny*end);
    path.lineTo(wx-nx*end,wy-ny*end); path.lineTo(ex-nx*start,ey-ny*start); path.closePath();
    for (const [cx,cy,r] of [[ex,ey,start],[wx,wy,end]]) {
      path.moveTo(cx+r,cy);path.arc(cx,cy,r,0,Math.PI*2,true);
    }
    return true;
  }
  async function occlude(ctx, t, part = "subject", viewport = [0,0,ctx.canvas.width,ctx.canvas.height]) {
    const frame = at(t);
    if (!frame?.matte || !["subject","hands","left","right","arms","leftArm","rightArm"].includes(part)) return false;
    const img = await image(frame.matte), [u,v,dw,dh] = frame.rect, [x,y,w,h] = viewport;
    ctx.save();
    try {
      ctx.setTransform(1,0,0,1,0,0);
      if (part !== "subject") {
        const arms = part === "arms" || part.endsWith("Arm");
        const sides = part==="arms" ? ["left","right"] : part==="hands" ? Object.keys(frame.hands) : [part.replace("Arm","")];
        const path = new Path2D();let found=false;
        for (const side of sides) {
          if (arms && forearmPath(path,frame.body,side,viewport)) found=true;
          if (frame.hands[side] && handPath(path,frame.hands[side],viewport,frame.body[side+"Wrist"])) found=true;
        }
        if (!found) return false;
        ctx.clip(path);
      }
      ctx.globalAlpha=1; ctx.globalCompositeOperation="destination-out";
      ctx.drawImage(img,x+u*w,y+v*h,dw*w,dh*h);
      return true;
    } finally { ctx.restore(); }
  }
  return { at, point, bone, occlude, size, duration };
}
