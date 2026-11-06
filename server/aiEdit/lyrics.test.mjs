import { expect, it } from "vitest";
import { placeLyricWords, transcribeLyrics, lyricSourceContext } from "./lyrics.mjs";
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const clip = { kind: "audio", speed: 2, source: { start_us: 16000000, duration_us: 8000000 }, timeline: { start_us: 5000000, duration_us: 4000000 } };
it("clips boundary words and maps the retained part to a shifted, sped-up music track", () => {
  const words = [[15, 16], [15.8, 16.4], [20, 21], [23.5, 24.1], [24, 24.4]].map(([start, end]) => ({ start, end, text: " word", confidence: 0.8 }));
  expect(placeLyricWords(words, clip, 16, 24).map(w => [w.source_start, w.source_end, w.start, w.end]))
    .toEqual([[16, 16.4, 5, 5.2], [20, 21, 7, 7.5], [23.5, 24, 8.75, 9]]);
});
it("rejects an offset past the selected source before opening any media", async () => {
  await expect(transcribeLyrics({ store: { getSegment: async () => clip } }, { clip_id: "audio", offset: 8 })).rejects.toMatchObject({ code: "arguments_invalid" });
});
it('preserves onset uncertainty through source trimming, speed and timeline shifts',()=>{
  const [word]=placeLyricWords([{text:'hello',start:15.9,end:16.8,onset_range:[15.9,16.4],confidence:.8}],clip,16,24);
  expect(word).toMatchObject({start:5,end:5.4,onset_range:[5,5.2]});
});

it('maps a unique source interval but refuses to select an arbitrary source from a mixture',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'lyric-context-')),file=path.join(root,'source.wav');
  try{
    await writeFile(file,'source fixture');
    const music={...clip,id:'music',path:file,volume:1},video={...music,id:'video',kind:'video',path:'camera.mov',volume:0};
    const project={tracks:[{segments:[music]},{segments:[video]}]};
    const ctx={store:{getProject:async()=>project},library:{idForPath:p=>p===file?'music':'video',get:id=>({id,hasAudio:true,source:{type:'local'}}),readyPath:()=>file}};
    const check={audio:{start:6,duration:1,source_clips:['music']}};
    expect(await lyricSourceContext(ctx,check)).toMatchObject({file,from:18,to:20,speed:2,at:6});
    video.volume=1;expect(await lyricSourceContext(ctx,check)).toBeNull();
    project.tracks[1].mute=true;expect(await lyricSourceContext(ctx,check)).not.toBeNull();
    expect(await lyricSourceContext(ctx,{audio:{start:4,duration:3}})).toBeNull();
    expect(await lyricSourceContext(ctx,{audio:{...check.audio,source_clips:['embedded-page-audio']}})).toBeNull();
    ctx.store.getProject=async()=>{throw Error('Should use the rendered project snapshot');};
    expect(await lyricSourceContext(ctx,check,project)).not.toBeNull();
  }finally{await rm(root,{recursive:true,force:true});}
});
