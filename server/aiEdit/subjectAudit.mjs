// Read the actual live runtime from the composed page, including nested film pages.
// The result complements visual review; it does not grade inferred background pixels.
export const SUBJECT_AUDIT_READ=`(()=>{
 const reports=[],seen=new Set();
 function visit(w){if(seen.has(w))return;seen.add(w);try{
  for(const [id,track] of Object.entries(w.smartcutSubjects??{})){
   if(typeof track.effects?.audit==='function'){const r=track.effects.audit();if(r.applicable)reports.push({trackId:id,...r});}
   if(typeof track.motion?.audit==='function'){const r=track.motion.audit();if(r.applicable)reports.push({trackId:id,...r});}
  }
  for(const frame of w.document.querySelectorAll('iframe'))if(frame.contentWindow)visit(frame.contentWindow);
 }catch(e){reports.push({status:'fail',issues:['主体运行时验收无法读取：'+e.message]});}}
 visit(window);return {applicable:reports.length>0,status:reports.some(r=>r.status!=='pass')?'fail':'pass',reports};
})()`;
