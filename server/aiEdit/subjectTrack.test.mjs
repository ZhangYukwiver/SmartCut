import { describe, expect, it } from "vitest";
import { subjectPlayback } from "./subjectPlayback.mjs";
import { trackSubject,subjectBoundarySupport } from "./subjectTrack.mjs";

describe("subject tracking", () => {
  it('measures real frame contacts while excluding cropped-ROI edges and opposite-edge ambiguity',()=>{
    const info={width:30,height:20,channels:4},data=new Uint8Array(30*20*4);
    for(let y=10;y<20;y++)for(let x=0;x<12;x++)data[(y*30+x)*4+3]=255;
    expect(subjectBoundarySupport(data,info).edges).toEqual(['left','bottom']);
    expect(subjectBoundarySupport(data,info,[.2,.2,.4,.4])).toBeNull();
    data.fill(255);expect(subjectBoundarySupport(data,info)).toBeNull();
  });
  it("keeps masks and bones on the displayed source frame through VFR holds, speed changes and a lost subject", () => {
    const a = {time: 0, body: {neck:[0.5,0.2,1]}, hands:{}};
    const b = {time: 0.03355, body:{}, hands:{left:{wrist:[0.3,0.4,0.8],middleMCP:[0.4,0.5,0.9],indexTip:[0.2,0.1,0.13]}}};
    const lost = {time: 0.1835, body:{}, hands:{}};
    const track = subjectPlayback([a,b,lost],[1920,1080],2,0.2,"https://example.invalid/pages/track.js");
    expect(track.at(0.01666)).toBe(b);
    expect(track.at(0.08)).toBe(b);
    expect(track.bone(0.08,"left.wrist","left.middleMCP").angle).toBeCloseTo(Math.atan2(108,192));
    expect(track.point(0.08,"left.indexTip")).toBeNull();
    expect(track.point(0.095,"left.wrist")).toBeNull();
    expect(track.at(0.2)).toBeNull();
  });
  it.skipIf(process.platform!=="darwin")("rejects a target outside the image without starting a worker",async()=>{
    await expect(trackSubject({}, {clip_id:"v",mode:"body",seed:[1.25,.4]})).rejects.toThrow(/归一化/);
  });
  it("accepts the common pinky name without silently losing a hand twist anchor",()=>{
    const point=[.4,.5,.8];
    const s=subjectPlayback([{time:0,body:{},hands:{left:{littleMCP:point}}}],[1920,1080],1,1,'https://example.invalid/track.js');
    expect(s.point(.1,'hand.pinkyMCP')).toBe(point);
    expect(s.point(.1,'left.littleMCP')).toBe(point);
  });
});
