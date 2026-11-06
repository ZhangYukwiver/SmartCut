import {describe,it,expect} from 'vitest';
import vm from 'node:vm';
import {subjectMotion} from './subjectMotion.mjs';
import {subjectCarousel} from './subjectCarousel.mjs';
import {SUBJECT_AUDIT_READ} from './subjectAudit.mjs';

const smooth=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
function fixture({lost=false,approach=false,repeatPress=false,...overrides}={}){
  const track={size:[1000,600],duration:3,point(t,key){
    if(t<0||t>=3||lost&&t>1.2&&t<1.6)return null;
    const x=.4+.25*smooth((t-.4)/.4)-.25*smooth((t-1.1)/.5)+(approach ? .2*smooth((t-1.75)/.3) : 0);
    const dip=(Math.max(0,1-Math.abs(t-2.2)/.14)+(repeatPress?Math.max(0,1-Math.abs(t-2.65)/.14):0))*.07;
    return {indexTip:[x,.30+dip,1],indexMCP:[x-.02,.56,1],littleMCP:[x-.12,.59,1],wrist:[x-.1,.75,1]}[key.split('.')[1]]??null;
  }};
  track.motion=subjectMotion(track);
  const options={items:[{id:'a'},{id:'b'},{id:'c'}],viewport:[0,80,1000,450],center:[500,290],card:[220,300],spacing:250,initialIndex:1,start:.1,requiredDirections:['left','right'],...overrides};
  return {track,options,c:track.motion.carousel(options)};
}
const context=()=>({globalAlpha:1,save(){},restore(){},beginPath(){},rect(){},clip(){},fillRect(){},drawImage(){},fillText(){}});
const images={a:{width:200,height:300},b:{width:200,height:300},c:{width:200,height:300}};
describe('tracked game carousel',()=>{
  it('ends browsing without ending click detection and shares one selection across layout, highlight and confirmation',()=>{
    const {track,c}=fixture({approach:true,repeatPress:true,browseUntil:1.7});
    expect(c.drags.map(d=>d.direction)).toEqual(['right','left']);
    for(let n=0;n<90;n++){
      const t=n/30,state=c.at(t);
      expect(c.selection.at(t)).toEqual(state);
      expect(state.cards.filter(x=>x.selected).map(x=>x.id)).toEqual([state.selected]);
      expect(state.item.id).toBe(state.selected);
      if(t>=1.7)expect(state.selected).toBe('b');
    }
    expect(c.selection.events).toHaveLength(1);
    expect(c.selection.events[0]).toMatchObject({time:2.2,target:'b'});
    expect(track.motion.isConfirmation(c.selection.events[0])).toBe(true);
    expect(c.at(2.4)).toMatchObject({selected:'b',selectedIndex:1,confirmed:true,event:{target:'b'}});
    const later=c.at(2.8);c.at(.5);expect(c.at(2.8)).toEqual(later);
    const ctx=context();for(let n=0;n<90;n++)c.draw(ctx,n/30,{images,showLabel:false});
    expect(c.audit()).toMatchObject({status:'pass',selection:{consistent:true},confirmation:{target:'b'}});
  });
  it('does not expose mutable gesture or confirmation caches',()=>{
    const {c,options}=fixture();const expected=c.at(2.4);
    expect(()=>c.drags.splice(1)).toThrow();
    expect(()=>{c.drags[0].target=99;}).toThrow();
    expect(()=>{c.at(.6).active.from[0]=0;}).toThrow();
    expect(()=>{c.selection.events[0].target='c';}).toThrow();
    options.items[1].id='changed';options.center[0]=0;
    expect(c.at(2.4)).toEqual(expected);
    expect(()=>fixture({browseUntil:.05})).toThrow(/参数/);
    expect(()=>fixture({browseUntil:4})).toThrow(/参数/);
  });
  it('follows the nonlinear pointer in both directions, snaps, and keeps focus off the cards',()=>{
    const {track,c}=fixture();expect(c.drags.map(d=>d.direction)).toEqual(['right','left']);
    for(const d of c.drags){
      for(const f of [.25,.5,.75]){const t=d.start+(d.end-d.start)*f;expect((d.position-c.at(t).position)*250).toBeCloseTo(track.motion.point(t,'hand.indexTip')[0]-d.from[0],6);}
      const t=d.end+.13,state=c.at(t);expect(state.position).toBe(d.target);expect(state.selected).toBeTruthy();
      // The selection is the settled card, even though the pointer is at its edge.
      expect(c.at(t+.03).selected).toBe(state.selected);
    }
    const expected=c.at(.6);c.at(2.8);expect(c.at(.6)).toEqual(expected);
    expect(c.selection.events).toHaveLength(1);expect(c.selection.events[0]).toMatchObject({time:2.2,target:'b'});
    expect(track.motion.isConfirmation(c.selection.events[0])).toBe(true);
  });
  it('fails acceptance without actual drawing, counts both directions, and feeds the composition gate',()=>{
    const {track,c}=fixture();expect(c.audit().status).toBe('fail');
    const ctx=context();for(let n=0;n<90;n++)c.draw(ctx,n/30,{images});
    const audit=c.audit();expect(audit.status).toBe('pass');expect(audit.checks).toHaveLength(2);expect(audit.checks.every(x=>x.snapErrorPx===0&&x.maxFollowErrorPx<1e-6)).toBe(true);
    const w={smartcutSubjects:{test:track},document:{querySelectorAll:()=>[]}};
    expect(vm.runInNewContext(SUBJECT_AUDIT_READ,{window:w})).toMatchObject({applicable:true,status:'pass'});
    const missing=fixture({lost:true});for(let n=0;n<90;n++)missing.c.draw(ctx,n/30,{images});
    expect(missing.c.audit()).toMatchObject({status:'fail'});
  });
  it('serializes the same native controller for portable projects and rejects misleading gain',()=>{
    const {track,options,c}=fixture();
    const make=vm.runInNewContext('('+subjectMotion.toString()+')');
    const factory=vm.runInNewContext('('+subjectCarousel.toString()+')');
    const portable=make(track,factory).carousel(options);
    expect(JSON.stringify(portable.at(1.4))).toBe(JSON.stringify(c.at(1.4)));
    expect(()=>track.motion.carousel({...options,gain:.22})).toThrow(/参数/);
    expect(()=>c.draw(context(),1,{images:{}})).toThrow(/未解码/);
  });
});
