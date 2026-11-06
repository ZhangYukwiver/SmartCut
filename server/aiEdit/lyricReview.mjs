import { requestAnalysis } from '../videoAnalysis.mjs';
import { modelFetch } from '../systemProxy.mjs';
import { analyzeLyricsAudio, lyricSourceContext, placeLyricWords } from './lyrics.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { sliceLyricWav } from './lyricAudio.mjs';

export const lyricTokens = text => String(text).normalize('NFKC').toLowerCase().replace(/[’']/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [];
const round = n => Math.round(n * 1000) / 1000;
const uncertain = reason => ({ lyric_accuracy: { status: 'uncertain', reason }, synchronization: { status: 'uncertain', reason } });
const timedTokens = words => (words ?? []).flatMap(w => lyricTokens(w.text).map(text => ({ ...w, text })));

export function contextWordTiming(contextWords, mixWords) {
  const source=timedTokens(contextWords),mix=timedTokens(mixWords),pairs=alignLyricTokens(source.map(w=>w.text),mix.map(w=>w.text)).pairs,matches=new Map(pairs);
  return source.map((word,i)=>{
    const other=mix[matches.get(i)];
    if(!other)return {...word,timing_source:'mapped_original_context'};
    const ranges=[...(word.onset_range??[word.start,word.start]),...(other.onset_range??[other.start,other.start])];
    return {...word,start:Math.min(...ranges),onset_range:[Math.min(...ranges),Math.min(word.end,Math.max(...ranges))],
      confidence:Math.min(word.confidence??0,other.confidence??0),context_start:word.start,mix_start:other.start,timing_source:'original_context_and_actual_mix',timing_conflict:other.start>word.end||other.end<word.start};
  });
}

// Sequence alignment retains repeated words. It does not turn a forced alignment
// of supplied text into evidence that the text was actually sung.
export function alignLyricTokens(expected, actual) {
  const rows = Array.from({ length: expected.length + 1 }, () => Array(actual.length + 1).fill(0));
  for (let i=0;i<=expected.length;i++) rows[i][0]=i;
  for (let j=0;j<=actual.length;j++) rows[0][j]=j;
  for(let i=1;i<=expected.length;i++)for(let j=1;j<=actual.length;j++)rows[i][j]=Math.min(rows[i-1][j]+1,rows[i][j-1]+1,rows[i-1][j-1]+(expected[i-1]===actual[j-1]?0:1));
  const pairs=[],differences=[];let i=expected.length,j=actual.length;
  while(i||j){
    if(i&&j&&rows[i][j]===rows[i-1][j-1]+(expected[i-1]===actual[j-1]?0:1)){i--;j--;if(expected[i]===actual[j])pairs.push([i,j]);else differences.push({expected:expected[i],displayed:actual[j],expected_index:i,displayed_index:j});}
    else if(i&&rows[i][j]===rows[i-1][j]+1){i--;differences.push({expected:expected[i],displayed:null,expected_index:i});}
    else{j--;differences.push({expected:null,displayed:actual[j],displayed_index:j,expected_gap:i});}
  }
  return {pairs:pairs.reverse(),differences:differences.reverse(),distance:rows[expected.length][actual.length]};
}

export function observeLyricTiming(frames, fps) {
  const words=[],paints=new Map();let previous=[],ids=[],lastTime=-Infinity;
  const scoped=frames.some(frame=>(frame.boxes??[]).some(box=>box.lyric_scope===true));
  for(const frame of frames){
    const current=(frame.boxes??[]).filter(b=>(!scoped||b.lyric_scope===true)&&['canvas-fill','dom-text'].includes(b.kind)&&(b.alpha??1)>.08&&(b.glyph_coverage??1)>.2)
      .flatMap(b=>lyricTokens(b.text).map(text=>({text,paint:b.paint??null})));
    if(!current.length)continue;
    const tokens=current.map(w=>w.text);let overlap=0;
    if(frame.time-lastTime<.2)for(let n=Math.min(previous.length,tokens.length);n>0;n--)if(previous.slice(-n).every((w,i)=>w===tokens[i])){overlap=n;break;}
    const nextIds=ids.slice(ids.length-overlap);
    for(let i=overlap;i<tokens.length;i++){nextIds.push(words.length);words.push({text:tokens[i],appearance:frame.time,frames:[]});}
    for(let i=0;i<current.length;i++){
      const sample={time:frame.time,paint:current[i].paint};words[nextIds[i]].frames.push(sample);
      if(sample.paint)paints.set(sample.paint,(paints.get(sample.paint)??0)+1);
    }
    previous=tokens;ids=nextIds;lastTime=frame.time;
  }
  // Cumulative karaoke spends MORE time highlighted than unhighlighted. The
  // initial color of each newly visible word identifies the base, not duration.
  const initial=new Map();for(const w of words){const p=w.frames.find(f=>f.paint)?.paint;if(p)initial.set(p,(initial.get(p)??0)+1);}
  const palette=[...paints].sort((a,b)=>b[1]-a[1]),base=[...initial].sort((a,b)=>b[1]-a[1])[0]?.[0]??palette[0]?.[0],changing=palette.length>1;
  return {mode:changing?'paint-change':'appearance',base_paint:base??null,words:words.map(w=>{
    const active=changing?w.frames.filter(f=>f.paint&&f.paint!==base):w.frames;
    return {text:w.text,appearance:round(w.appearance),start:active.length?round(active[0].time):null,end:active.length?round(active.at(-1).time+1/fps):null,observed_frames:w.frames.length,active_frames:active.length};
  })};
}

export function lyricConsensus(transcripts) {
  const base=lyricTokens(transcripts[0]),alternatives=transcripts.slice(1).map(text=>{
    const tokens=lyricTokens(text),a=alignLyricTokens(base,tokens),mapped=Array(base.length).fill(null),gaps=new Map();
    for(const[i,j]of a.pairs)mapped[i]=tokens[j];
    for(const d of a.differences){if(d.expected_index!==undefined)mapped[d.expected_index]=d.displayed;else{const list=gaps.get(d.expected_gap)??[];list.push(d.displayed);gaps.set(d.expected_gap,list);}}
    return {mapped,gaps};
  });
  const uncertain=[];
  for(let i=0;i<=base.length;i++){
    const inserted=alternatives.map(a=>a.gaps.get(i)??[]);
    if(inserted.some(a=>a.length))uncertain.push({index:i,kind:'insertion',alternatives:[null,...inserted.map(a=>a.join(' ')||null)],reason:'独立听音对额外词存在分歧，缺少可确认的逐词时间'});
    if(i===base.length)break;
    const readings=[base[i],...alternatives.map(a=>a.mapped[i])];
    if(readings.some(w=>w!==base[i]))uncertain.push({index:i,kind:'word',alternatives:[...new Set(readings)],reason:'独立音频转写不一致；联合听看不作为唱词票数'});
  }
  return {transcript:base.join(' '),uncertain};
}

export function focusedLyricWindows(consensus, words, duration) {
  const timed=timedTokens(words),windows=[];
  for(const item of consensus.uncertain){
    const i=Math.min(item.index,timed.length-1),word=timed[i];
    if(!word||!Number.isFinite(word.start)||!(word.end>word.start))continue;
    const start=Math.max(0,word.start-1.2,timed[Math.max(0,i-2)].start-.12);
    const end=Math.min(duration,start+4,Math.max(word.end+.12,timed[Math.min(timed.length-1,i+3)].end+.12));
    if(end<=start)continue;
    const last=windows.at(-1);
    if(last&&start<=last.end+.15&&Math.max(last.end,end)-last.start<=4)last.end=Math.max(last.end,end);
    else if(windows.length<3)windows.push({start:round(start),end:round(end)});
  }
  return windows.map(w=>({...w,word_start:timed.findIndex(x=>x.end>w.start),word_end:timed.findLastIndex(x=>x.start<w.end)+1}));
}

export function resolveFocusedLyrics(consensus, words, focused) {
  const tokens=timedTokens(words).map(w=>w.text),resolved=[];
  const remaining=consensus.uncertain.filter(item=>{
    if(item.kind==='insertion')return true;
    const readings=focused.filter(f=>!f.error&&f.listening?.heard&&!f.listening.uncertain.length&&item.index>=f.word_start&&item.index<f.word_end).map(f=>({f,matched:alignLyricTokens(tokens.slice(f.word_start,f.word_end),lyricTokens(f.listening.transcript))}));
    if(readings.some(({f,matched})=>matched.differences.some(d=>d.expected_index===item.index-f.word_start)))return true;
    const proof=readings.find(({f,matched})=>{
      if(f.error||!f.listening?.heard||f.listening.uncertain.length||item.index<f.word_start||item.index>=f.word_end)return false;
      const expected=tokens.slice(f.word_start,f.word_end),index=item.index-f.word_start,positions=new Map(matched.pairs),at=positions.get(index);
      // A disputed word must agree with independent ASR, plus nearby context.
      // Repeating the original mix or agreeing with visible text is not proof.
      return at!==undefined&&matched.pairs.length>=Math.min(3,expected.length)&&expected.length>1
        &&(index===0||positions.get(index-1)===at-1)&&(index===expected.length-1||positions.get(index+1)===at+1);
    })?.f;
    if(!proof)return true;
    resolved.push({...item,word:tokens[item.index],window:{start:proof.start,end:proof.end},basis:'独立本地ASR与一次去伴奏盲听在该词及邻近上下文一致'});
    return false;
  });
  return {...consensus,uncertain:remaining,resolved};
}

export function assessLyricEvidence({ listening, alignment, observed, judgment, consensus, offset = 0, fps = 30 }) {
  if(!listening.heard||!listening.transcript?.trim())return uncertain('实际合成音轨未识别到可核对唱词');
  const expected=lyricTokens(listening.transcript),actual=observed.words.map(w=>w.text),matched=alignLyricTokens(expected,actual);
  const aligned=timedTokens(alignment.candidates?.[0]?.words??alignment.words);
  const unforced=lyricTokens((alignment.words??[]).map(w=>w.text).join(' '));
  const acousticAgreement=alignLyricTokens(expected,unforced);
  const reasons=[];
  if(listening.uncertain?.length)reasons.push('盲听仍有不确定唱词：'+listening.uncertain.join('；'));
  const uncertainIndexes=new Set(consensus?.uncertain.map(x=>x.index)??[]);
  const confidentDifferences=matched.differences.filter(d=>!uncertainIndexes.has(d.expected_index??d.expected_gap));
  const lyricStatus=confidentDifferences.length?'fail':matched.distance||reasons.length||uncertainIndexes.size?'uncertain':'pass';
  const timing=[],missing=[],weak=[];
  if(alignLyricTokens(expected,aligned.map(w=>w.text)).distance)return {lyric_accuracy:{status:lyricStatus,differences:matched.differences,reasons},synchronization:{status:'uncertain',reason:'声学对齐未覆盖独立盲听的全部词，不能按猜测时间验收'}};
  // A wrong word can still be on time. Evaluate 1:1 substitutions without
  // turning a lyric disagreement into a synchronization failure.
  const pairs=[...matched.pairs,...matched.differences.filter(d=>d.expected_index!==undefined&&d.displayed_index!==undefined).map(d=>[d.expected_index,d.displayed_index])].sort((a,b)=>a[0]-b[0]);
  const threshold=120+1000/fps;
  for(const [i,j] of pairs){
    const a=aligned[i],v=observed.words[j];
    if(v.start===null){missing.push({word:a.text,expected_start:round(a.start+offset)});continue;}
    const delta=round(v.start-(a.start+offset));
    const left=matched.pairs.findLast(([at])=>at<i)??[-1,-1],right=matched.pairs.find(([at])=>at>i)??[expected.length,actual.length];
    const oneToOne=right[0]-left[0]===right[1]-left[1],confident=Number.isFinite(a.confidence)&&a.confidence>=.35&&a.end>a.start;
    const reliable=confident&&!a.timing_conflict&&(a.text===v.text||oneToOne);
    const latest=Array.isArray(a.onset_range)&&a.onset_range.length===2&&a.onset_range.every(Number.isFinite)?Math.max(a.start,Math.min(a.end,a.onset_range[1])):a.start;
    const range=[Math.round((v.start-latest-offset)*1000),Math.round(delta*1000)];
    const timingStatus=!reliable?'uncertain':range[0]>threshold||range[1]<-threshold?'fail':Math.max(...range.map(Math.abs))<=threshold?'pass':'uncertain';
    timing.push({word:a.text,displayed_word:v.text,lexical_match:a.text===v.text,audio_start:round(a.start+offset),audio_start_range:[round(a.start+offset),round(latest+offset)],visual_start:v.start,delta_ms:Math.round(delta*1000),delta_range_ms:range,confidence:a.confidence,reliable,reliability_reason:!confident?'low_asr_confidence':a.timing_conflict?'timing_context_conflict':!reliable?'ambiguous_word_mapping':null,timing_status:timingStatus});
    if(!confident)weak.push(a.text);
  }
  const errors=timing.filter(w=>w.timing_status!=='uncertain').map(w=>Math.max(...w.delta_range_ms.map(Math.abs))).sort((a,b)=>a-b),p95=errors.length?errors[Math.min(errors.length-1,Math.floor(errors.length*.95))]:null,max=errors.at(-1)??null;
  const bad=timing.filter(w=>w.timing_status==='fail'),uncertainTiming=timing.filter(w=>w.timing_status==='uncertain');
  const incomplete=pairs.length!==expected.length||pairs.length!==actual.length;
  const measured=missing.length||bad.length?'fail':!timing.length||uncertainTiming.length||incomplete?'uncertain':'pass';
  const syncStatus=measured==='fail'||(judgment?.heard_audio===true&&judgment.sync_status==='fail')?'fail':measured!=='pass'||judgment?.heard_audio!==true||judgment?.sync_status!=='pass'?'uncertain':'pass';
  return {
    lyric_accuracy:{status:lyricStatus,transcript:listening.transcript,displayed:actual.join(' '),differences:matched.differences,confirmed_differences:confidentDifferences,uncertain_words:consensus?.uncertain??[],reasons,
      resolved_words:consensus?.resolved??[],independent_local_asr:(alignment.words??[]).map(w=>w.text).join(' '),local_asr_disagreements:acousticAgreement.differences,method:'独立本地ASR对照纯音频盲听；争议词最多一次去伴奏局部盲听，必须与独立ASR及邻近上下文一致。联合听看不参与唱词投票。'},
    synchronization:{status:syncStatus,measurement_status:measured,method:'实际合成视频与音轨联合听看，另以真实亮词逐帧观测和独立ASR起点区间核对；保留ASR原始时间，能量提示不覆盖原时间；低置信度或无法对应的起点不用于确定错拍',audiovisual_status:judgment?.heard_audio===true?judgment.sync_status:'uncertain',audiovisual_reason:judgment?.sync_reason??'未完成联合听看',mode:observed.mode,fps,tolerance_ms:round(threshold),p95_error_ms:p95,max_error_ms:max,words:timing,late_or_early:bad,uncertain_timings:uncertainTiming,missing_highlights:missing,low_confidence_words:weak,expected_words:expected.length,measured_words:errors.length,incomplete_word_mapping:incomplete},
  };
}

export function parseListening(text) {
  const value=JSON.parse(text.trim().replace(/^```(?:json)?\s*/u,'').replace(/\s*```$/u,''));
  if(typeof value.heard!=='boolean'||typeof value.transcript!=='string'||value.transcript.length>5000||!Array.isArray(value.uncertain)||value.uncertain.some(x=>typeof x!=='string')||!/^[a-z]{2,3}$/u.test(value.language??''))throw Error('音频评审缺少实际听见的唱词与不确定项');
  return value;
}

async function audioModel(ctx,state){
  if(state.config)return state.config;
  const config=[ctx.analysis,ctx.config].find(c=>c?.baseUrl&&c.apiKey&&(!c.runtime||c.runtime==='api'));
  if(!config)throw Error('没有配置可听音频的API服务');
  if(/omni/iu.test(config.model)&&!/realtime/iu.test(config.model))return state.config=config;
  const r=await (ctx.fetchImpl??modelFetch)(config.baseUrl.replace(/\/$/u,'')+'/models',{headers:{Authorization:`Bearer ${config.apiKey}`},signal:ctx.signal});
  if(!r.ok)throw Error('不能读取当前服务的音频模型目录');
  const catalog=await r.json();
  const model=(catalog.data??[]).map(x=>x.id).filter(x=>/^qwen.*omni/iu.test(x)&&!/(realtime|\d{4}-\d{2}-\d{2})/u.test(x)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}))[0];
  if(!model)throw Error('当前服务没有可用的非实时音频理解模型');
  return state.config={...config,model};
}

export async function reviewLyrics(ctx,boundaryCheck,clip,projectSnapshot=null){
  if(!boundaryCheck.audio||boundaryCheck.audio.peak<.001)return uncertain('合成音轨为空或静音，未完成听音验收');
  const state=(ctx.reviewBudget??={}).audio??={cache:new Map(),judgments:new Map(),calls:0};
  try{
    const {file,data}=await ctx.reviewClips.readAudio(boundaryCheck.audio.file),config=await audioModel(ctx,state);
    const ask=async (prompt,video,audio=data)=>{
      if(state.calls>=8)throw Error('本轮音频复核达到8次上限');
      state.calls++;const began=Date.now();let usage;
      try{return await requestAnalysis({config,parts:[...(video?[{type:'video_url',video_url:{url:`data:video/mp4;base64,${video.toString('base64')}`},fps:clip.fps}]:[]),{type:'input_audio',input_audio:{data:`data:audio/wav;base64,${audio.toString('base64')}`,format:'wav'}}],prompt,reasoningEffort:'none',signal:AbortSignal.any([ctx.signal,AbortSignal.timeout(180000)].filter(Boolean)),fetchImpl:ctx.fetchImpl??modelFetch,onUsage:u=>{usage=u;}});}
      finally{await ctx.onVisionCall?.({role:'音频验收',runtime:'api',model:config.model,input:'audio',startedAt:new Date(began).toISOString(),elapsedMs:Date.now()-began,usage});}
    };
    const sourceContext=await lyricSourceContext(ctx,boundaryCheck,projectSnapshot);
    const key='independent-v3|'+boundaryCheck.audio.sha256+'|'+JSON.stringify(sourceContext?.stamp??null);
    let evidence=state.cache.get(key);
    if(!evidence){
      ctx.onGenerating?.('正在独立听取实际合成音轨中的唱词…');
      const listening=parseListening(await ask('只根据所附音频逐字转写实际人声词句（唱词或口语都转写），不联网，不猜歌名或补全熟悉的歌词，不读取任何候选词表。保留原语言、重复词和实际口语；数字按实际读出的词写，不合并为数字。听不清的词记入uncertain，不假装听清。只返回JSON：{"heard":true,"language":"en","transcript":"音频中实际发出的完整文字","uncertain":["具体听不清处"]}。没有可识别人声时heard=false、transcript为空。'));
      if(!listening.heard||!listening.transcript.trim())return {...uncertain('音频模型没有听到可核对唱词'),audio_model:config.model,blind_listening:listening};
      ctx.onGenerating?.('正在独立识别人声并保留争议词的诊断音轨…');
      const vocalFile=file.replace(/\.wav$/u,'-vocals.wav');
      const alignment=await analyzeLyricsAudio(ctx,file,0,boundaryCheck.audio.duration,{language:listening.language,mix:false,preparedFile:vocalFile});
      if(!alignment.words?.length)return {...uncertain('独立本地识别没有可核对的人声词，不能让听看模型充当第二票'),audio_model:config.model,blind_listening:listening};
      let sourceEvidence=null;
      if(sourceContext){
        ctx.onGenerating?.('正在用原曲截取前后的上下文交叉核对词与起点…');
        const original=await analyzeLyricsAudio(ctx,sourceContext.file,sourceContext.from,sourceContext.to,{language:listening.language,mix:false});
        const words=placeLyricWords(original.words,sourceContext.clip,sourceContext.from,sourceContext.to).map(w=>({...w,start:round(w.start-sourceContext.at),end:round(w.end-sourceContext.at),...(w.onset_range?{onset_range:w.onset_range.map(t=>round(t-sourceContext.at))}:{})}));
        if(words.length){
          sourceEvidence={media_id:sourceContext.stamp[0],source_start:sourceContext.from,source_end:sourceContext.to,speed:sourceContext.speed,transcript:words.map(w=>w.text).join(' '),words};
          alignment.mix_words=alignment.words;
          alignment.words=contextWordTiming(words,alignment.words);
        }
      }
      const initial=lyricConsensus([alignment.words.map(w=>w.text).join(' '),listening.transcript]),focused=[];
      if(initial.uncertain.length&&alignment.prepared_audio){
        const vocals=await readFile(vocalFile),windows=focusedLyricWindows(initial,alignment.words,Math.min(boundaryCheck.audio.duration,alignment.prepared_audio.duration));
        for(const [i,window] of windows.entries()){
          const result={...window};
          try{
            const sliced=sliceLyricWav(vocals,window.start,window.end),name=vocalFile.replace(/\.wav$/u,`-focus-${i}.wav`);
            await writeFile(name,sliced.data,{mode:0o600});
            Object.assign(result,{start:sliced.start,end:round(sliced.start+sliced.duration),audio_file:boundaryCheck.audio.file.replace(/\.wav$/u,`-vocals-focus-${i}.wav`),sha256:sliced.sha256});
            ctx.onGenerating?.(`正在诊断 ${result.start.toFixed(2)}–${result.end.toFixed(2)} 秒争议唱词（去伴奏、独立盲听）…`);
            result.listening=parseListening(await ask('只听所附人声短片，逐字转写实际发声，不联网、不猜歌名、不补熟悉歌词。该片经过人声分离和恒定增益，时长与播放速度保持不变，首尾可能截断；不能把处理伪影猜成词。不提供候选词表，也不要根据任何画面作答。只返回JSON：{"heard":true,"language":"en","transcript":"实际完整听见的词","uncertain":["听不清或截断的位置"]}。没有可识别人声时heard=false。',null,sliced.data));
          }catch(error){ctx.signal?.throwIfAborted();result.error=error.message;}
          focused.push(result);
        }
      }
      evidence={listening,alignment,sourceEvidence,focused,consensus:resolveFocusedLyrics(initial,alignment.words,focused)};
      // Cache this diagnostic attempt even when a word stays uncertain. A new
      // page version must not turn the same audio into another lottery ticket.
      state.cache.set(key,evidence);
    }
    const frames=await ctx.reviewClips.readBoundaries(boundaryCheck.boundary_file);
    const observed=observeLyricTiming(frames.frames,boundaryCheck.boundaries.fps);
    const displayed=observed.words.map(w=>w.text).join(' '),judgmentKey=key+'|'+clip?.key+'|'+displayed;
    let judgment=state.judgments.get(judgmentKey);
    if(!judgment){
      const paired=clip&&Math.abs(clip.start-boundaryCheck.boundaries.start)<.001&&Math.abs(clip.duration-boundaryCheck.audio.duration)<.001;
      ctx.onGenerating?.('正在同时听看完整合成，核对唱词与听感同步…');
      judgment=paired?JSON.parse((await ask('同时听看所附完整合成视频与同步音轨，只判断实际人声发声与逐词亮起是否同步：有无明显抢拍、迟到、缺失或错位，指出具体时刻。唱词拼写准确性由独立音频验收处理，本次不转写歌词，不把可见文字当作听音证据。只返回JSON：{"heard_audio":true,"sync_status":"pass|fail|uncertain","sync_reason":"具体声画时序证据或无法判断的原因"}。',await readFile(clip.file))).trim().replace(/^```(?:json)?\s*/u,'').replace(/\s*```$/u,'')):{heard_audio:false,sync_status:'uncertain',sync_reason:'没有与完整验收音轨同区间的合成视频'};
      if(!['pass','fail','uncertain'].includes(judgment.sync_status)||typeof judgment.sync_reason!=='string'||typeof judgment.heard_audio!=='boolean')throw Error('声画复听返回格式不完整');
      state.judgments.set(judgmentKey,judgment);
    }
    const {consensus,alignment}=evidence;
    return {...assessLyricEvidence({listening:{...evidence.listening,transcript:consensus.transcript},alignment,observed,judgment,consensus,offset:boundaryCheck.boundaries.start,fps:boundaryCheck.boundaries.fps}),audio_model:config.model,audio:boundaryCheck.audio,blind_listening:evidence.listening,listening_judgment:judgment,consensus,alignment_words:alignment.words,
      focused_listening:evidence.focused,source_context:evidence.sourceEvidence,actual_mix_asr:alignment.mix_words??alignment.words,vocal_preparation:alignment.prepared_audio?{...alignment.prepared_audio,file:boundaryCheck.audio.file.replace(/\.wav$/u,'-vocals.wav')}:null,
      diagnosis_policy:'同一音轨最多3段、每段不超过4秒的去伴奏盲听；不展示候选词，不重复尝试；必须与独立本地ASR及上下文一致才能解除该词分歧。'};
  }catch(error){ctx.signal?.throwIfAborted();return {...uncertain(error.message),audio_model:state.config?.model,error_code:error.code??'audio_review_incomplete'};}
}
