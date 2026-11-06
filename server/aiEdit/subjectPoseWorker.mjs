import {parentPort,workerData} from 'node:worker_threads';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

export const HAND_KEYS=['wrist','thumbCMC','thumbMP','thumbIP','thumbTip','indexMCP','indexPIP','indexDIP','indexTip','middleMCP','middlePIP','middleDIP','middleTip','ringMCP','ringPIP','ringDIP','ringTip','littleMCP','littlePIP','littleDIP','littleTip'];
const PALM=[0,5,9,13,17];
export function solveLinear(a,b){
  const rows=a.map((r,i)=>[...r,b[i]]),n=b.length;
  for(let i=0;i<n;i++){
    let k=i;for(let j=i+1;j<n;j++)if(Math.abs(rows[j][i])>Math.abs(rows[k][i]))k=j;
    if(Math.abs(rows[k][i])<1e-10)return null;
    [rows[k],rows[i]]=[rows[i],rows[k]];const d=rows[i][i];for(let j=i;j<=n;j++)rows[i][j]/=d;
    for(let k=0;k<n;k++)if(k!==i){const f=rows[k][i];for(let j=i;j<=n;j++)rows[k][j]-=f*rows[i][j];}
  }
  return rows.map(r=>r[n]);
}
// Fit camera pose to the neural metric hand shape, never assign constant z.
// Focal length is an explicit prior: these are monocular estimates, not measured metres.
export function cameraFit(world,image,size,fov=60){
  const f=size[0]/(2*Math.tan(fov*Math.PI/360)),a=[],b=[];
  for(const i of PALM){const [x,y,z]=world[i],[u,v]=image[i],rx=(u-size[0]/2)/f,ry=(v-size[1]/2)/f;a.push([1,0,-rx],[0,1,-ry]);b.push(rx*z-x,ry*z-y);}
  const ata=Array.from({length:3},(_,i)=>Array.from({length:3},(_,j)=>a.reduce((s,r)=>s+r[i]*r[j],0))),atb=[0,1,2].map(i=>a.reduce((s,r,k)=>s+r[i]*b[k],0));
  const t=solveLinear(ata,atb);if(!t)return null;
  const transform=(p,q)=>{
    const [rx,ry,rz]=q,cx=Math.cos(rx),sx=Math.sin(rx),cy=Math.cos(ry),sy=Math.sin(ry),cz=Math.cos(rz),sz=Math.sin(rz);
    const a=[p[0],p[1]*cx-p[2]*sx,p[1]*sx+p[2]*cx],b=[a[0]*cy+a[2]*sy,a[1],-a[0]*sy+a[2]*cy];
    return [b[0]*cz-b[1]*sz+q[3],b[0]*sz+b[1]*cz+q[4],b[2]+q[5]];
  };
  const residual=q=>PALM.flatMap(i=>{const p=transform(world[i],q);return [(size[0]/2+f*p[0]/p[2]-image[i][0])/f,(size[1]/2+f*p[1]/p[2]-image[i][1])/f];});
  let q=[0,0,0,...t],lambda=1e-4;
  const loss=r=>r.reduce((s,v)=>s+v*v,0);
  for(let iter=0;iter<35;iter++){
    const r=residual(q),columns=q.map((_,i)=>{const v=q.slice();v[i]+=1e-5;return residual(v).map((x,k)=>(x-r[k])/1e-5);});
    const h=q.map((_,i)=>q.map((_,j)=>columns[i].reduce((s,x,k)=>s+x*columns[j][k],0)+(i===j?lambda:0))),g=columns.map(c=>-c.reduce((s,x,k)=>s+x*r[k],0));
    const delta=solveLinear(h,g);if(!delta)break;
    const next=q.map((v,i)=>v+delta[i]);
    if(next[5]>.04&&Math.hypot(...next.slice(0,3))<Math.PI*.6&&loss(residual(next))<loss(r)){q=next;lambda=Math.max(1e-8,lambda*.4);if(Math.hypot(...delta)<1e-7)break;}else lambda*=8;
  }
  const camera=world.map(p=>transform(p,q));if(camera.some(p=>p[2]<.04||p[2]>4))return null;
  const projected=camera.map(([x,y,z])=>[size[0]/2+f*x/z,size[1]/2+f*y/z]);
  const error=Math.sqrt(PALM.reduce((s,i)=>s+(projected[i][0]-image[i][0])**2+(projected[i][1]-image[i][1])**2,0)/PALM.length);
  return {camera,translation:q.slice(3),rotation:q.slice(0,3),reprojectionPx:error,fov};
}
export function decodeHandPose(outputs,crop,size,observed){
  const values=Object.values(outputs).map(x=>x.data),landmarks=values.find(x=>x.length===63&&Math.max(...x)>2),worldRaw=values.find(x=>x.length===63&&Math.max(...x)<2);
  // The pinned ONNX export names confidence Identity_1, handedness Identity_2.
  const confidence=outputs.Identity_1?.data[0];
  if(!(confidence>=.7)||!landmarks||!worldRaw)return null;
  const rotate=(x,y)=>[crop.across[0]*x-crop.up[0]*y,crop.across[1]*x-crop.up[1]*y];
  const world=[],image=[];
  for(let i=0;i<21;i++){
    const [x,y]=rotate((landmarks[i*3]-112)*crop.scale,(landmarks[i*3+1]-112)*crop.scale);
    image.push([x+crop.center[0],y+crop.center[1],landmarks[i*3+2]*crop.scale]);
    world.push([...rotate(worldRaw[i*3],worldRaw[i*3+1]),worldRaw[i*3+2]]);
  }
  const span=Math.hypot(image[5][0]-image[17][0],image[5][1]-image[17][1]);
  const pairs=PALM.filter(i=>observed[HAND_KEYS[i]]?.[2]>=.25);
  if(pairs.length<4||span<8)return null;
  const identityError=Math.sqrt(pairs.reduce((s,i)=>{const p=observed[HAND_KEYS[i]];return s+(image[i][0]-p[0]*size[0])**2+(image[i][1]-p[1]*size[1])**2;},0)/pairs.length)/span;
  const fit=cameraFit(world,image,size);
  if(identityError>.35||!fit||fit.reprojectionPx/span>.15)return null;
  return {world:Object.fromEntries(HAND_KEYS.map((k,i)=>[k,world[i]])),camera:Object.fromEntries(HAND_KEYS.map((k,i)=>[k,fit.camera[i]])),image:Object.fromEntries(HAND_KEYS.map((k,i)=>[k,image[i]])),confidence,identityError,reprojectionPx:fit.reprojectionPx,fov:fit.fov,kind:'monocular-neural-estimate',model:'mediapipe-handpose-2023feb-db0898ae'};
}
export async function estimateHandPoses({folder,model,size},progress=()=>{}){
  const [ort,{default:sharp}]=await Promise.all([import('onnxruntime-node'),import('sharp')]);
  const rows=JSON.parse(await readFile(path.join(folder,'frames.json'))),session=await ort.InferenceSession.create(model,{executionProviders:['cpu'],intraOpNumThreads:2,logSeverityLevel:3});
  let accepted=0,total=0;
  try{for(let n=0;n<rows.length;n++){
    const row=rows[n];row.handPose3D={};
    for(const [side,crop]of Object.entries(row.handCrops??{})){
      total++;const rgb=await sharp(path.join(folder,crop.file)).removeAlpha().raw().toBuffer();
      const pixels=Float32Array.from(rgb,x=>x/255),result=await session.run({[session.inputNames[0]]:new ort.Tensor('float32',pixels,[1,224,224,3])});
      const pose=decodeHandPose(result,crop,size,row.hands[side]);if(pose){row.handPose3D[side]=pose;accepted++;}
    }
    if(n%15===0)progress(`本机三维手姿估计 ${n+1}/${rows.length}`);
  }}finally{await session.release();}
  await writeFile(path.join(folder,'frames.json'),JSON.stringify(rows));
  await writeFile(path.join(folder,'pose-summary.json'),JSON.stringify({model:'mediapipe-handpose-2023feb-db0898ae',accepted,total,kind:'monocular-neural-estimate',fov:60,limitations:['相对深度及尺度为单目模型估计，不是传感器测量','未见肘部时前臂深度方向需要掌面先验和轮廓约束']}));
}
if(parentPort)estimateHandPoses(workerData,stage=>parentPort.postMessage({stage})).then(()=>parentPort.postMessage({ok:true}),e=>parentPort.postMessage({error:'三维手姿估计失败：'+e.message}));
