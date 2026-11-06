import {describe,it,expect} from 'vitest';
import {cameraFit,decodeHandPose} from './subjectPoseWorker.mjs';
import {subjectMotion} from './subjectMotion.mjs';
import {subjectEffects} from './subjectEffects.mjs';

describe('monocular hand depth and axial rotation',()=>{
  it('recovers camera depth from a known nonplanar hand instead of a constant depth ratio',()=>{
    const world=Array.from({length:21},(_,i)=>[(i%5-2)*.016,(Math.floor(i/5)-2)*.02,Math.sin(i)*.006]);
    const size=[1920,1080],f=1920/(2*Math.tan(Math.PI/6)),translation=[-.05,.02,.45];
    const image=world.map(p=>{const [x,y,z]=p.map((v,i)=>v+translation[i]);return[960+f*x/z,540+f*y/z];});
    const fit=cameraFit(world,image,size);expect(fit.reprojectionPx).toBeLessThan(.001);expect(fit.translation[2]).toBeCloseTo(.45,4);
    const rotated=world.map(([x,y,z])=>{const a=[x,y*Math.cos(.3)-z*Math.sin(.3),y*Math.sin(.3)+z*Math.cos(.3)];return [a[0]*Math.cos(-.2)+a[2]*Math.sin(-.2),a[1],-a[0]*Math.sin(-.2)+a[2]*Math.cos(-.2)].map((v,i)=>v+translation[i]);});
    const tiltedImage=rotated.map(([x,y,z])=>[960+f*x/z,540+f*y/z]),tilted=cameraFit(world,tiltedImage,size);
    expect(tilted.reprojectionPx).toBeLessThan(.01);
    // All 21 points, including joints excluded from the five-point fit, must agree.
    expect(Math.max(...tilted.camera.map((p,i)=>Math.hypot(...p.map((v,k)=>v-rotated[i][k]))))).toBeLessThan(.0001);
    expect(cameraFit(world,world.map(()=>[960,540]),size)).toBeNull();
    expect(decodeHandPose({Identity_1:{data:[.1]}},{},size,{})).toBeNull();
  });
  it('uses depth and the palm normal even when all 2D joints remain stationary',()=>{
    const joints={wrist:[.3,.8,1],indexMCP:[.48,.47,1],middleMCP:[.42,.45,1],littleMCP:[.34,.5,1],indexTip:[.65,.26,1]};
    const track={size:[1000,600],kind:'hand',duration:2,point:(t,k)=>t<0||t>=2?null:joints[k.split('.')[1]],at(t){if(t<0||t>=2)return null;const f=1000/(2*Math.tan(Math.PI/6)),camera={};for(const[k,p]of Object.entries(joints)){const z=.35+(k==='indexMCP'?.025*Math.sin(t*2):0);camera[k]=[(p[0]-.5)*1000/f*z,(p[1]-.5)*600/f*z,z];}return {hands:{right:joints},support:{edgeAnchor:[.02,.88]},handPose3D:{right:{camera,kind:'monocular-neural-estimate',fov:60,confidence:.95}}};}};
    track.motion=subjectMotion(track);track.effects=subjectEffects(track);
    const actor=track.effects.bindHand({calibrationTime:.2,pose:'3d',widthScale:1.4});
    expect(actor.kind).toBe('hand-pose-3d');expect(actor.pose(.3).end).toEqual(actor.pose(.7).end);
    expect(actor.pose(.3).rotation).not.toBeCloseTo(actor.pose(.7).rotation,3);
    expect(actor.pose(.3).depth.estimated).toBe(true);
    expect(()=>track.effects.bindHand({calibrationTime:.2,pose:'3d',depthRatio:.72})).toThrow(/depthRatio/);
    const animated=track.effects.bindHand({calibrationTime:.2,pose:'3d',widthScale:1.4,motion:[{time:2,swing:[0,0,0],twist:0},{time:2.8,swing:[0,18,24],twist:25}]});
    expect(animated.pose(.7).silhouette).toEqual(actor.pose(.7).silhouette);
    expect(animated.pose(1.9,[1000,600],2.8).end).not.toEqual(animated.pose(1.9).end);
    expect(animated.pose(1.9,[1000,600],2.8).rotation).not.toBeCloseTo(animated.pose(1.9).rotation);
    expect(()=>track.effects.bindHand({calibrationTime:.2,pose:'3d',motion:[{time:1,swing:[0,0,0]},{time:2.8,swing:[0,18,24]}]})).toThrow(/不能覆盖实拍/);
  });
  it('bridges only bracketed short model gaps while 2D identity remains observed',()=>{
    const hand={wrist:[.4,.5,1]},pose=z=>({camera:{wrist:[0,0,z]},kind:'monocular-neural-estimate',confidence:.9});
    const track={size:[100,100],duration:1,point:(t)=>t>=0&&t<1?hand.wrist:null,at:t=>t>=0&&t<1?{hands:{right:hand},handPose3D:t>.48&&t<.52?{}:{right:pose(t<.5?.3:.4)}}:null};
    const motion=subjectMotion(track);expect(motion.hand3D(.5).camera.wrist[2]).toBeCloseTo(.35);expect(motion.hand3D(.5).temporalBridge).toBeDefined();expect(motion.hand3D(1)).toBeNull();
    track.point=()=>null;expect(motion.hand3D(.5)).toBeNull();
    expect(()=>subjectEffects({size:[100,100],duration:1,motion:{palmBinding:()=>({}),hand3D:()=>null}}).bindHand({calibrationTime:.1,pose:'3d'})).toThrow(/三维手姿/);
  });
});
