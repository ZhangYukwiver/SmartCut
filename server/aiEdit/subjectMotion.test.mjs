import {describe,it,expect} from 'vitest';
import {subjectMotion} from './subjectMotion.mjs';
import {subjectEffects} from './subjectEffects.mjs';

function fixture(){
 const joints={wrist:[.3,.8,1],indexMCP:[.48,.47,1],middleMCP:[.42,.45,1],littleMCP:[.34,.5,1],indexTip:[.65,.26,1]};
 const track={size:[1000,600],duration:3,point:(t,key)=>t<0||t>=3?null:joints[key.split('.')[1]]??null};
 track.motion=subjectMotion(track);track.effects=subjectEffects(track);return {joints,track};
}
describe('subject action binding',()=>{
 it('separates finger flexion from the rigid palm while wrist movement changes the limb',()=>{
  const {track,joints}=fixture(),actor=track.effects.bindHand({calibrationTime:.2});
  const before=actor.pose(.3);joints.indexTip=[.47,.6,1];const flexed=actor.pose(.4);
  expect(flexed.silhouette).toEqual(before.silhouette);
  for(const key of Object.keys(joints))joints[key]=[joints[key][0]+.04,joints[key][1]-.02,1];
  const moved=actor.pose(.5);expect(moved.end[0]-before.end[0]).toBeCloseTo(40);expect(moved.end[1]-before.end[1]).toBeCloseTo(-12);
  joints.wrist=null;expect(actor.pose(.6)).toBeNull();
 });
 it('calibrates twist against rest instead of saturating an absolute palm angle',()=>{
  const {track,joints}=fixture(),actor=track.effects.bindHand({calibrationTime:.2,roll:25});
  expect(actor.pose(.3).rotation*180/Math.PI).toBeCloseTo(25);
  joints.littleMCP=[.34,.55,1];const turned=actor.pose(.4);
  expect(turned.rotation).not.toBeCloseTo(actor.pose(.3).rotation,3);
  expect(actor.palm.at(.4).twistClamped).toBe(false);
 });
 it('places the cap at the knuckles, fits its cross-section, and uses observed frame contact for the root',()=>{
  const {track,joints}=fixture();track.kind='hand';track.at=()=>({hands:{left:joints},support:{edgeAnchor:[.02,.88]}});
  const actor=track.effects.bindHand({calibrationTime:.2,widthScale:1.4}),p=actor.pose(.2),center=[0,1].map(k=>(joints.indexMCP[k]+joints.middleMCP[k]+joints.littleMCP[k])/3*track.size[k]);
  expect(p.end[0]).toBeCloseTo(center[0]);expect(p.end[1]).toBeCloseTo(center[1]);
  expect(actor.calibration.rootSource).toBe('observed-mask-frame-contact');
  expect(actor.calibration.error).toBeLessThan(.02);
  expect(p.capSpan/actor.palm.reference.span).toBeCloseTo(1.4,1);
  const other=fixture();other.joints.indexTip=[.85,.1,1];other.track.kind='hand';other.track.at=()=>({hands:{left:other.joints},support:{edgeAnchor:[.02,.88]}});
  const changed=other.track.effects.bindHand({calibrationTime:.2,widthScale:1.4});expect(changed.pose(.2).silhouette).toEqual(p.silhouette);
  const impossible=track.effects.bindHand({calibrationTime:.2,widthScale:.8});track.effects.replacement({actor:impossible,transition:{start:1,duration:.5}});
  expect(track.effects.audit().issues).toContain('三维截面与观测掌宽的校准误差超过12%');
 });
 it('moves candidate and confirmation times with measured dip-return and rejects a target miss',()=>{
  function make(offset){
   const track={size:[1000,600],duration:3,point(t,k){if(t<0||t>=3)return null;const dt=t-(1+offset),dip=Math.max(0,1-Math.abs(dt)/.16)*.12;
    return {wrist:[.35,.8,1],indexMCP:[.45,.5,1],littleMCP:[.35,.55,1],indexTip:[.62,.27+dip,1]}[k.split('.')[1]];}};
   const motion=subjectMotion(track),events=motion.gestures();return {motion,events};
  }
  const a=make(0),b=make(.5);expect(a.events.presses.length).toBe(1);expect(b.events.presses[0].time-a.events.presses[0].time).toBeCloseTo(.5);
  const selected=a.motion.selector({events:a.events,targets:[{id:'minecraft',rect:[.55,.25,.2,.25]}]});
  expect(selected.events[0].target).toBe('minecraft');expect(a.motion.isConfirmation(selected.events[0])).toBe(true);
  expect(a.motion.selector({events:a.events,targets:[{id:'miss',rect:[0,0,.2,.2]}]}).events).toEqual([]);
  expect(a.motion.isConfirmation({...selected.events[0]})).toBe(false);
  const event=selected.events[0];expect(selected.at(event.time+.12).feedbackOpacity).toBeCloseTo(.5);expect(selected.at(event.time+.3).ready).toBe(false);expect(selected.at(event.feedback.readyAt).ready).toBe(true);
  const fx=subjectEffects({size:[1000,600],duration:3,motion:a.motion});
  const actor={pose:()=>null};fx.replacement({actor,transition:{event,duration:.8}});
  expect(fx.audit().checks[0].event.transformStart).toBeCloseTo(event.time+.49);
  expect(()=>fx.replacement({actor,transition:{event,delay:-.2,duration:.8}})).toThrow(/确认反馈/);
 });
});
