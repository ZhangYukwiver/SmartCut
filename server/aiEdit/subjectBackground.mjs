import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,copyFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {AiEditError} from './library.mjs';

const execute=promisify(execFile),worker=fileURLToPath(new URL('./subjectBackgroundWorker.py',import.meta.url)).replace(/([\\/]app\.asar)([\\/])/u,'$1.unpacked$2');
export function backgroundPlayback(data,base){
  let canvas,ctx,padded;const image=new Image();image.src=new URL('clean.png',base).href;
  const [iw,ih]=data.size;let minX=0,minY=0,maxX=iw,maxY=ih;
  for(const frame of data.frames){const [a,b,c,d,e,f]=frame.matrix,det=a*e-b*d;
    for(const [x,y] of [[0,0],[iw,0],[iw,ih],[0,ih]]){
      const sx=((x-c)*e-b*(y-f))/det,sy=((y-f)*a-d*(x-c))/det;
      minX=Math.min(minX,sx);minY=Math.min(minY,sy);maxX=Math.max(maxX,sx);maxY=Math.max(maxY,sy);
    }
  }
  const left=Math.ceil(-minX)+2,top=Math.ceil(-minY)+2,right=Math.ceil(maxX-iw)+2,bottom=Math.ceil(maxY-ih)+2;
  const ready=image.decode().then(()=>{
    padded=document.createElement('canvas');padded.width=iw+left+right;padded.height=ih+top+bottom;const g=padded.getContext('2d');
    g.drawImage(image,left,top,iw,ih);
    // A registered reference can move offscreen. Extend only its boundary pixels;
    // transparent warp borders would reveal the old sleeve under the replacement.
    g.drawImage(image,0,0,1,ih,0,top,left,ih);g.drawImage(image,iw-1,0,1,ih,left+iw,top,right,ih);
    g.drawImage(image,0,0,iw,1,left,0,iw,top);g.drawImage(image,0,ih-1,iw,1,left,top+ih,iw,bottom);
    for(const [sx,sy,dx,dy,dw,dh] of [[0,0,0,0,left,top],[iw-1,0,left+iw,0,right,top],[0,ih-1,0,top+ih,left,bottom],[iw-1,ih-1,left+iw,top+ih,right,bottom]])g.drawImage(image,sx,sy,1,1,dx,dy,dw,dh);
  });
  return {summary:{...data,frames:undefined,edgeFill:{method:'clamped-reference-border',padding:[left,top,right,bottom],observed:false}},ready,async frame(t,w,h){
    await ready;if(!canvas||canvas.width!==w||canvas.height!==h){canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;ctx=canvas.getContext('2d');}
    const frames=data.frames;let lo=0,hi=frames.length;while(lo+1<hi){const mid=(lo+hi)>>1;if(frames[mid].time<=t+.001)lo=mid;else hi=mid;}
    const [a,b,c,d,e,f]=frames[lo].matrix;ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,w,h);ctx.scale(w/data.size[0],h/data.size[1]);ctx.transform(a,d,b,e,c,f);ctx.drawImage(padded,-left,-top);return canvas;
  }};
}
export async function buildSubjectBackground(ctx,{clip_id,track_id,reference_time}){
  if(!/^[a-f0-9]{24}$/u.test(track_id)||!Number.isFinite(reference_time)||reference_time<0)throw new AiEditError('arguments_invalid','需要本轮有效主体轨迹和参考时刻',422);
  const root=path.dirname(ctx.library.root),trackFolder=path.join(root,'pages','_subject_'+track_id);
  const analysis=JSON.parse(await readFile(path.join(trackFolder,'analysis.json'))),clip=await ctx.store.getSegment(ctx.projectId,clip_id);
  const mediaId=ctx.library.idForPath(clip.path);
  if(mediaId!==analysis.mediaId||Math.abs(clip.source.start_us/1e6-analysis.start)>.001||reference_time>=analysis.duration)throw new AiEditError('background_source_mismatch','背景必须使用与主体轨迹相同的原片片段',422);
  const key=createHash('sha256').update(await readFile(worker)).update(backgroundPlayback.toString()).update(track_id).update(String(reference_time)).digest('hex').slice(0,24);
  const folder=path.join(root,'pages','_background_'+key),script=path.join(folder,'background.js');
  let summary;
  try{await stat(script);summary=JSON.parse(await readFile(path.join(folder,'summary.json')));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!summary){
    const python=process.env.SMARTCUT_TRACK_PYTHON||process.env.SMARTCUT_ASR_PYTHON||path.join(root,'asr','venv',...(process.platform==='win32'?['Scripts','python.exe']:['bin','python']));
    ctx.onGenerating?.('正在从原片多帧恢复背景并配准遮挡区域…');
    try{
      await mkdir(folder,{recursive:true});
      await execute(python,['-I','-X','utf8',worker,ctx.library.readyPath(mediaId),trackFolder,folder,String(reference_time)],{signal:ctx.signal,timeout:300000,maxBuffer:2*1024*1024});
      const data=JSON.parse(await readFile(path.join(folder,'alignment.json')));
      let clean=path.join(folder,'observed.png'),inpaintId=null;
      if(data.structure){clean=path.join(folder,'structural.png');}
      else if(data.inferredFraction>.0001){
        const original=await ctx.library.importFile(clean,'本轮原片多帧背景-已观测区域.png',{source:{type:'subject_background',mediaId,trackId:track_id,operation:'observed-background'}});
        const repaired=await ctx.imageRefine.repairMask(original.id,await readFile(path.join(folder,'unknown.png')),{signal:ctx.signal,progress:ctx.onGenerating});
        clean=ctx.library.readyPath(repaired.id);inpaintId=repaired.id;
      }
      await copyFile(clean,path.join(folder,'clean.png'));
      const cleanItem=await ctx.library.importFile(path.join(folder,'clean.png'),'本轮配准背景-待视觉验收.png',{source:{type:'subject_background',mediaId,trackId:track_id,operation:data.structure?'structure-continuation':'temporal-inpaint'}});
      const coverageItem=await ctx.library.importFile(path.join(folder,'coverage.png'),'本轮背景真实观测覆盖图.png',{source:{type:'subject_background',mediaId,trackId:track_id,operation:'coverage'}});
      summary={...data,frames:undefined,trackId:track_id,sourceMediaId:mediaId,inpaintId,clean_media_id:cleanItem.id,coverage_media_id:coverageItem.id,limitations:['仿射背景配准，强视差镜头需分平面恢复','未露出区域是结构延拓或模型补全，必须复核暗块、结构线和接缝']};
      await writeFile(path.join(folder,'summary.json'),JSON.stringify(summary));
      await writeFile(script,'(window.smartcutBackgrounds??={})['+JSON.stringify(key)+']=('+backgroundPlayback.toString()+')('+JSON.stringify({...summary,frames:data.frames})+',document.currentScript.src);');
    }catch(e){if(ctx.signal?.aborted)throw e;throw new AiEditError('subject_background_failed','背景恢复未完成：'+String(e.stderr||e.message).slice(-800),422);}finally{ctx.onGenerating?.(null);}
  }
  return {...summary,background_id:key,script_src:'../_background_'+key+'/background.js',clean_src:'../_background_'+key+'/clean.png',coverage_src:'../_background_'+key+'/coverage.png',
    usage:'引入 script_src 后 const background=smartcutBackgrounds[background_id]；等待 background.ready；fx.draw(ctx,t,{background,behind:HUD,texture,sourceTime:t})。内部逐帧配准，不要将clean.png当静态底图直接覆盖。coverage.png亮处为多个原片帧实际观测，暗处为推测补全；完整合成须检查未观测区、踢脚线和回填接缝。'};
}
