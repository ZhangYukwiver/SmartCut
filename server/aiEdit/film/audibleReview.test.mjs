import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromeProvider, findBrowser, openTab } from './browser.mjs';
import { createFilmFiles } from './serve.mjs';
const providers=[];
afterEach(async()=>{await Promise.all(providers.splice(0).map(p=>p.close()));},30000);

it.skipIf(!findBrowser())('audits the same trimmed, shifted and attenuated mix that the exporter hears',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'audible-review-')),provider=chromeProvider();providers.push(provider);
  const rate=16000,buffer=Buffer.alloc(44+rate*2);buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(rate*2,40);
  for(let i=0;i<rate;i++)buffer.writeInt16LE(Math.round(Math.sin(i/rate*440*2*Math.PI)*16000),44+i*2);
  await mkdir(path.join(root,'media'));const filename='a'.repeat(32)+'.wav';await writeFile(path.join(root,'media',filename),buffer);
  const files=createFilmFiles({root});const server=createServer(async(req,res)=>{if(!await files.handle(req,res,new URL(req.url,'http://localhost')))res.writeHead(404).end();});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let tab;
  try{
    const origin=`http://127.0.0.1:${server.address().port}`;tab=await openTab(provider,files.urlFor(origin,'__encoder.html'),{plain:true});
    const result=await tab.evaluate(`enc.audio(${JSON.stringify({duration:1,sounds:[{src:files.urlFor(origin,'media/'+filename),from:.2,to:.6,at:.3,volume:.5}],wav:{start:.25,duration:.5}})})`);
    expect(result.skipped).toEqual([]);expect(result.frames).toBe(24000);expect(result.peak).toBeCloseTo(16000/32768*.5,2);
    const wav=Buffer.from(result.wav,'base64');expect(wav.subarray(0,4).toString()).toBe('RIFF');
    const active=[];for(let i=0;i<24000;i++)if(Math.abs(wav.readInt16LE(44+i*4))>100)active.push(i/48000);
    expect(active[0]).toBeCloseTo(.05,2);expect(active.at(-1)).toBeCloseTo(.45,2);
  }finally{await tab?.close();await provider.close();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
},30000);
