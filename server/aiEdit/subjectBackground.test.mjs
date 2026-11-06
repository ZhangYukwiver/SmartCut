import {it,expect} from 'vitest';
import {createServer} from 'node:http';
import {backgroundPlayback} from './subjectBackground.mjs';
import {chromeProvider,findBrowser,openTab} from './film/browser.mjs';

it.skipIf(!findBrowser())('fills registered borders instead of exposing the removed subject, including backwards seeks',async()=>{
  const html=`<script>const build=${backgroundPlayback.toString()};window.film={duration:2,frame(){}};window.check=async()=>{
    const b=build({size:[48,32],frames:[{time:0,matrix:[1,0,7,0,1,3]},{time:1,matrix:[.99,-.04,-5,.04,.99,-4]}]},location.href);
    const inspect=async t=>{const c=await b.frame(t,96,64),d=c.getContext('2d').getImageData(0,0,96,64).data;return {minAlpha:Math.min(...Array.from(d).filter((_,i)=>i%4===3)),corner:Array.from(d.slice(0,4))}};
    const first=await inspect(0),second=await inspect(1),back=await inspect(0);return {first,second,back,edge:b.summary.edgeFill};};</script>`;
  const server=createServer((req,res)=>{if(req.url==='/clean.png'){res.writeHead(200,{'Content-Type':'image/svg+xml'});res.end('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="32"><path fill="#789abc" d="M0 0h48v32H0z"/></svg>');}else{res.writeHead(200,{'Content-Type':'text/html'});res.end(html);}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const provider=chromeProvider();let tab;
  try{tab=await openTab(provider,`http://127.0.0.1:${server.address().port}/index.html`,{width:96,height:64});const r=await tab.evaluate('window.check()');expect(r.first.minAlpha).toBe(255);expect(r.second.minAlpha).toBe(255);expect(r.first.corner).toEqual([120,154,188,255]);expect(r.back).toEqual(r.first);expect(r.edge.observed).toBe(false);}
  finally{await tab?.close();await provider.close();await new Promise(resolve=>server.close(resolve));}
},60000);
