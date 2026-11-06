import { expect, it } from 'vitest';
import { alignLyricTokens, assessLyricEvidence, contextWordTiming, focusedLyricWindows, lyricConsensus, observeLyricTiming, parseListening, resolveFocusedLyrics } from './lyricReview.mjs';

const tokens=['hello','blue','world'];
function frames(delay=0){return Array.from({length:42},(_,i)=>({time:i/30,boxes:tokens.map((text,k)=>({text,kind:'canvas-fill',alpha:1,glyph_coverage:1,paint:i/30>=k*.4+delay&&i/30<(k+1)*.4+delay?'#00ccff':'#ffffff'}))}));}
function evidence(delay=0){return {listening:{heard:true,transcript:'Hello blue world',language:'en',uncertain:[]},judgment:{status:'pass',reason:'实际听见一致',heard_audio:true,heard_transcript:'hello blue world',sync_status:'pass',sync_reason:'实际亮词和声音同步'},alignment:{words:tokens.map(text=>({text})),candidates:[{words:tokens.map((text,i)=>({text,start:i*.4,end:(i+1)*.4,confidence:.9}))}]},observed:observeLyricTiming(frames(delay),30)};}
it('measures color changes in actually drawn words and accepts matching audio onsets',()=>{
  const e=evidence();expect(e.observed.words.map(w=>w.start)).toEqual([0,.4,.8]);
  expect(assessLyricEvidence(e)).toMatchObject({lyric_accuracy:{status:'pass'},synchronization:{status:'pass',max_error_ms:0}});
});
it('rejects an audible 400ms lag even when text, code intent and clip durations agree',()=>{
  const result=assessLyricEvidence(evidence(.4));
  expect(result).toMatchObject({lyric_accuracy:{status:'pass'},synchronization:{status:'fail'}});
  expect(result.synchronization.max_error_ms).toBeGreaterThanOrEqual(400);
  expect(result.synchronization.max_error_ms).toBeLessThanOrEqual(434);
});
it('does not validate the supplied words merely because a forced aligner can time them',()=>{
  const e=evidence();e.observed.words[1].text='red';
  expect(assessLyricEvidence(e)).toMatchObject({lyric_accuracy:{status:'fail',differences:[{expected:'blue',displayed:'red'}]},synchronization:{status:'pass'}});
  e.observed.words[1].text='blue';e.judgment.status='uncertain';e.judgment.heard_transcript='hello red world';expect(assessLyricEvidence(e).lyric_accuracy.status).toBe('pass');
  e.listening.uncertain=['blue'];expect(assessLyricEvidence(e).lyric_accuracy.status).toBe('uncertain');e.listening.uncertain=[];
  e.judgment.status='pass';e.alignment.candidates[0].words[1].confidence=.1;e.judgment.sync_status='uncertain';expect(assessLyricEvidence(e).synchronization.status).toBe('uncertain');
});

it('does not reverse cumulative highlight colors when already-sung words stay lit',()=>{
  const data=Array.from({length:90},(_,i)=>({time:i/30,boxes:tokens.map((text,k)=>({text,kind:'dom-text',paint:i/30>=k*.4+.2?'rgb(169, 250, 255)':'rgb(229, 237, 245)'}))}));
  expect(observeLyricTiming(data,30).words.map(w=>w.start)).toEqual([.2,.633,1]);
});
it('uses explicitly marked lyric boxes without hiding wrong marked words',()=>{
  const data=Array.from({length:42},(_,i)=>({time:i/30,boxes:[
    {text:'My Song',kind:'dom-text',paint:'#fff'},
    ...tokens.map((text,k)=>({text,kind:'dom-text',lyric_scope:true,paint:i/30>=k*.4&&i/30<(k+1)*.4?'#0cf':'#fff'})),
  ]}));
  const observed=observeLyricTiming(data,30);expect(observed.words.map(w=>w.text)).toEqual(tokens);
  const e=evidence();e.observed=observed;expect(assessLyricEvidence(e).synchronization.status).toBe('pass');
  e.observed.words[1].text='red';expect(assessLyricEvidence(e).lyric_accuracy.status).toBe('fail');
});

it('keeps competing heard words uncertain instead of forcing a single blind transcript as truth',()=>{
  const c=lyricConsensus(['blue lantern so','blue lantern boy','blue lantern girl']);
  expect(c.transcript).toBe('blue lantern so');expect(c.uncertain).toMatchObject([{index:2,alternatives:['so','boy','girl']}]);
  expect(lyricConsensus(['blue lantern so','blue lantern boy','blue lantern boy'])).toMatchObject({transcript:'blue lantern so',uncertain:[{index:2,alternatives:['so','boy']}]});
  const e=evidence();e.listening.transcript='hello red world';e.consensus={uncertain:[{index:1,alternatives:['red','blue','green']}]};
  expect(assessLyricEvidence(e).lyric_accuracy.status).toBe('uncertain');
});

it('does not force an edit from an unreliable word onset or let lexical uncertainty erase measured synchronization',()=>{
  const e=evidence(.4);e.alignment.candidates[0].words.forEach(w=>w.confidence=.01);
  expect(assessLyricEvidence(e).synchronization).toMatchObject({status:'uncertain',measurement_status:'uncertain',late_or_early:[],measured_words:0});
  const synced=evidence();synced.consensus={uncertain:[{index:1,alternatives:['blue','red']}]};
  expect(assessLyricEvidence(synced)).toMatchObject({lyric_accuracy:{status:'uncertain'},synchronization:{status:'pass',measurement_status:'pass'}});
  const range=evidence();range.observed.words[0].start=.2;range.alignment.candidates[0].words[0].onset_range=[0,.25];
  expect(assessLyricEvidence(range).synchronization).toMatchObject({status:'uncertain',late_or_early:[],uncertain_timings:[{word:'hello',audio_start_range:[0,.25],delta_range_ms:[-50,200]}]});
  range.observed.words[0].start=.8;expect(assessLyricEvidence(range).synchronization.status).toBe('fail');
});

it('resolves only a localized audio disagreement confirmed by independent ASR and neighboring context',()=>{
  const words=['meet','girl','at','north','gate'].map((text,i)=>({text,start:i*.4,end:i*.4+.35}));
  const c=lyricConsensus([words.map(w=>w.text).join(' '),'meet boy at north gate']);
  const windows=focusedLyricWindows(c,words,2);expect(windows).toHaveLength(1);expect(windows[0].end-windows[0].start).toBeLessThanOrEqual(4);
  const read=transcript=>[{...windows[0],listening:{heard:true,transcript,uncertain:[]}}];
  expect(resolveFocusedLyrics(c,words,read('meet girl at north gate'))).toMatchObject({uncertain:[],resolved:[{index:1,word:'girl'}]});
  expect(resolveFocusedLyrics(c,words,read('meet boy at north gate')).uncertain).toHaveLength(1);
  expect(resolveFocusedLyrics(c,words,read('meet girl wait at north gate')).uncertain).toHaveLength(1);
  expect(resolveFocusedLyrics(c,words,read('girl')).uncertain).toHaveLength(1);
  const marked=read('meet girl at north gate');marked[0].listening.uncertain=['首词不清'];expect(resolveFocusedLyrics(c,words,marked).uncertain).toHaveLength(1);
  const many=Array.from({length:100},(_,i)=>({text:'word'+i,start:i,end:i+.7}));
  expect(focusedLyricWindows({uncertain:[0,20,40,60].map(index=>({index}))},many,100)).toHaveLength(3);
});

it('does not turn an ambiguous two-word versus three-word ending into a definite synchronization failure',()=>{
  const e=evidence();e.listening.transcript='take you closer';e.alignment.words=[{text:'take'},{text:'you'},{text:'closer'}];
  e.alignment.candidates[0].words=['take','you','closer'].map((text,i)=>({text,start:i*.4,end:(i+1)*.4,confidence:.95}));
  e.observed.words=[{text:'take',start:0},{text:'your',start:.4},{text:'clothes',start:.8},{text:'off',start:1.13}];
  const result=assessLyricEvidence(e);expect(result.synchronization).toMatchObject({status:'uncertain',late_or_early:[],incomplete_word_mapping:true});
  expect(result.synchronization.words.at(-1).reliability_reason).toBe('ambiguous_word_mapping');
});

it('keeps conflicting original-context and cut-only onsets as an interval instead of selecting the more confident guess',()=>{
  const source=[{text:'girl',start:2.12,end:2.52,confidence:.7,onset_range:[2.12,2.12]}],mix=[{text:'girl',start:2.38,end:2.52,confidence:.95,onset_range:[2.38,2.38]}];
  expect(contextWordTiming(source,mix)[0]).toMatchObject({start:2.12,onset_range:[2.12,2.38],confidence:.7,timing_conflict:false});
  expect(contextWordTiming(source,[{...mix[0],start:3,end:3.4}])[0].timing_conflict).toBe(true);
});
it('preserves repeated lyrics and refuses missing audio evidence',()=>{
  expect(alignLyricTokens(['boom','boom'],['boom']).distance).toBe(1);
  expect(alignLyricTokens(['boom','boom'],['boom','boom']).pairs).toEqual([[0,0],[1,1]]);
  const e=evidence();e.listening.heard=false;expect(assessLyricEvidence(e).lyric_accuracy.status).toBe('uncertain');
  expect(()=>parseListening('The audio is probably fine')).toThrow();
});
