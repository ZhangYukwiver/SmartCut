import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { sliceLyricWav } from './lyricAudio.mjs';
import { reviewLyrics } from './lyricReview.mjs';
import { analyzeLyricsAudio } from './lyrics.mjs';

vi.mock('./lyrics.mjs', async importOriginal => ({ ...await importOriginal(), analyzeLyricsAudio: vi.fn() }));
const roots=[];
afterEach(async()=>{vi.resetAllMocks();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
function pcm() {
  const b=Buffer.alloc(44+32000*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);
  for(let i=0;i<32000;i++)b.writeInt16LE(i%16000,44+i*2);
  return b;
}
it('extracts exact PCM samples without moving their source clock or changing the source',()=>{
  const wav=pcm(),before=Buffer.from(wav),cut=sliceLyricWav(wav,.25,.75);
  expect(cut).toMatchObject({start:.25,duration:.5});expect(cut.data.readUInt32LE(40)).toBe(16000);
  expect(cut.data.subarray(44)).toEqual(wav.subarray(44+4000*2,44+12000*2));expect(wav).toEqual(before);
  expect(()=>sliceLyricWav(wav,1.5,2.5)).toThrow('超出');expect(()=>sliceLyricWav(wav.subarray(0,-1),0,1)).toThrow('不完整');
});

it.each([{resolves:true,context:false},{resolves:false,context:false},{resolves:true,context:true}])('uses one bounded blind vocal diagnostic and caches it across page revisions (%j)',async({resolves,context})=>{
  const root=await mkdtemp(path.join(tmpdir(),'lyric-evidence-'));roots.push(root);
  const data=pcm(),file=path.join(root,'audio.wav'),video=path.join(root,'video.mp4');await writeFile(file,data);await writeFile(video,'video fixture');
  const words=['meet','girl','at','north','gate'].map((text,i)=>({text,start:.1+i*.3,end:.38+i*.3,confidence:.95}));
  analyzeLyricsAudio.mockImplementation(async(_ctx,_file,from,to,options)=>{
    if(!options.preparedFile){expect([from,to]).toEqual([16,18]);return{language:'en',words:words.map(w=>({...w,start:w.start+16,end:w.end+16}))};}
    expect(options.candidates).toBeUndefined();expect(options.preparedFile).not.toBe(file);await writeFile(options.preparedFile,data);
    return{words,language:'en',prepared_audio:{file:options.preparedFile,duration:2,source_start:0,frames:32000}};
  });
  const requests=[];let delay=0;
  const ctx={analysis:{model:'qwen3.8-omni-flash',baseUrl:'https://audio.example/v1',apiKey:'test'},signal:new AbortController().signal,reviewBudget:{},
    reviewClips:{readAudio:async()=>({file,data}),readBoundaries:async()=>({frames:Array.from({length:60},(_,i)=>({time:i/30,boxes:words.map(w=>({text:w.text,kind:'dom-text',paint:i/30>=w.start+delay?'yellow':'white'}))}))})},
    fetchImpl:async(_url,request)=>{
      const body=JSON.parse(request.body),parts=body.messages[0].content;requests.push(parts);
      const result=parts.some(p=>p.type==='video_url')?{heard_audio:true,sync_status:'pass',sync_reason:'aligned',status:'fail',heard_transcript:'wrong visible text'}:
        {heard:true,language:'en',transcript:requests.length===1?'meet boy at north gate':resolves?'meet girl at north gate':'meet boy at north gate',uncertain:[]};
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}),{headers:{'content-type':'application/json'}});
    }};
  if(context){
    const sourceFile=path.join(root,'original.wav');await writeFile(sourceFile,data);
    ctx.store={getProject:async()=>({tracks:[{segments:[{id:'music',kind:'audio',path:sourceFile,volume:1,source:{start_us:16e6,duration_us:2e6},timeline:{start_us:0,duration_us:2e6}}]}]})};
    ctx.library={idForPath:()=> 'music',get:()=>({id:'music',hasAudio:true,source:{type:'local'}}),readyPath:()=>sourceFile};
  }
  const bounds={audio:{file:'renders/test/audio.wav',sha256:'same-mix',start:0,duration:2,peak:.5,source_clips:['music']},boundary_file:'bounds.json',boundaries:{start:0,duration:2,fps:30}};
  const clip={file:video,key:'page-a',start:0,duration:2,fps:10};
  const first=await reviewLyrics(ctx,bounds,clip);
  expect(first.lyric_accuracy.status).toBe(resolves?'pass':'uncertain');expect(first.synchronization.status).toBe('pass');
  expect(first.focused_listening).toHaveLength(1);expect(requests).toHaveLength(3);
  const pure=requests.filter(p=>!p.some(x=>x.type==='video_url'));
  expect(pure).toHaveLength(2);expect(pure[0][0].input_audio.data).not.toBe(pure[1][0].input_audio.data);
  expect(pure.every(p=>!p.at(-1).text.includes('meet girl at north gate'))).toBe(true);
  delay=.4;const changed={...clip,key:'page-b'};
  const next=await reviewLyrics(ctx,bounds,changed);expect(next.synchronization.status).toBe('fail');
  expect(next.focused_listening).toEqual(first.focused_listening);expect(requests).toHaveLength(4);expect(analyzeLyricsAudio).toHaveBeenCalledTimes(context?2:1);
  await reviewLyrics(ctx,bounds,changed);expect(requests).toHaveLength(4);expect(await readFile(file)).toEqual(data);
});
