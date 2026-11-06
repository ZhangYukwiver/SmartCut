"""Local SmartCut lyric transcription. stdout carries one JSON result."""
import json
import sys
import tempfile
import wave as wav_file
from pathlib import Path

import av
import numpy as np
import onnxruntime as ort
from faster_whisper import WhisperModel
from faster_whisper.audio import pad_or_trim
from faster_whisper.tokenizer import Tokenizer
from huggingface_hub import hf_hub_download
from huggingface_hub.errors import LocalEntryNotFoundError


def model_file(cache, repo, revision, name):
    options = dict(repo_id=repo, revision=revision, filename=name, cache_dir=cache)
    try:
        return hf_hub_download(**options, local_files_only=True)
    except LocalEntryNotFoundError:
        return hf_hub_download(**options)


def decode_window(file, start, end):
    """Keep the stream clock through seeking, gaps and decoder priming."""
    rate = 44100
    wave = np.zeros((2, round((end - start) * rate)), dtype=np.float32)
    with av.open(file) as container:
        stream = container.streams.audio[0]
        base = float(stream.time_base)
        origin = (stream.start_time or 0) * base
        seek = max(0, start - 1)
        if seek:
            container.seek(int((origin + seek) / base), stream=stream)
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=rate)
        cursor = round((seek - start) * rate)
        written = 0

        def copy(frame):
            nonlocal cursor, written
            pos = cursor if frame.pts is None else round((float(frame.time) - origin - start) * rate)
            cursor = pos + frame.samples
            a, b = max(0, pos), min(wave.shape[1], cursor)
            if b > a:
                wave[:, a:b] = frame.to_ndarray()[:, a-pos:b-pos]
                written = max(written, b)

        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                copy(out)
            if cursor >= wave.shape[1]:
                break
        for out in resampler.resample(None):
            copy(out)
    if not written:
        raise ValueError("音频在指定范围内没有可解码的采样")
    return wave[:, :written]


def separate_vocals(wave, cache):
    """MDX-Net Inst HQ 3 predicts the stereo backing; keep the time-aligned residual."""
    model = model_file(cache, "Politrees/UVR_resources", "929e057b81aa49bc2e6490bef8671f47b2c120f6",
                       "models/MDXNet/UVR-MDX-NET-Inst_HQ_3.onnx")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    session = ort.InferenceSession(model, options, providers=["CPUExecutionProvider"])
    nfft, hop, bins, frames = 6144, 1024, 3072, 256
    window = np.hanning(nfft + 1)[:-1].astype(np.float32)
    # Overlap neighbouring predictions. Discard the padding before returning to the song clock.
    size = nfft + hop * (frames - 1)
    pad = size // 2
    padded = np.pad(wave, ((0, 0), (pad, size)))
    backing = np.zeros_like(padded)
    weights = np.zeros(padded.shape[1], dtype=np.float32)
    blend = np.hanning(frames + 2)[1:-1].astype(np.float32)
    for pos in range(0, pad + wave.shape[1], hop * frames // 2):
        block = padded[:, pos:pos+size]
        if block.shape[1] != size:
            break
        slices = np.lib.stride_tricks.sliding_window_view(block, nfft, axis=1)[:, ::hop]
        spec = np.fft.rfft(slices * window).transpose(0, 2, 1)[:, :bins]
        inp = np.ascontiguousarray(np.stack((spec.real, spec.imag), axis=1).reshape(1, 4, bins, frames), dtype=np.float32)
        inp[:, :, :3] = 0
        out = session.run(None, {session.get_inputs()[0].name: inp})[0].reshape(2, 2, bins, frames)
        chunks = np.fft.irfft((out[:, 0] + 1j*out[:, 1]).transpose(2, 0, 1), n=nfft)
        for j, samples in enumerate(chunks):
            offset = pos + j * hop
            backing[:, offset:offset+nfft] += samples * window * blend[j]
            weights[offset:offset+nfft] += window * window * blend[j]
    valid = slice(pad, pad + wave.shape[1])
    return wave - 1.022 * backing[:, valid] / np.maximum(weights[valid], 1e-6)


def compare_phrases(model, pcm, language, phrases, start, refine_onsets=False):
    """Score competing readings against the same audio and return their forced word alignments."""
    tokenizer = Tokenizer(model.hf_tokenizer, model.model.is_multilingual, task="transcribe", language=language)
    features = model.feature_extractor(pcm)
    encoded = model.encode(pad_or_trim(features))
    candidates = []
    for phrase in phrases:
        tokens = tokenizer.encode(" " + phrase.strip())
        alignment = model.find_alignment(tokenizer, [tokens], encoded, max(1, len(pcm) // 160))[0]
        if not alignment:
            continue
        weights = [len(w["tokens"]) for w in alignment]
        probabilities = np.maximum(1e-8, [w["probability"] for w in alignment])
        score = float(np.exp(np.average(np.log(probabilities), weights=weights)))
        candidates.append({"text": phrase, "score": round(score, 4), "words": [
            dict(text=w["word"], **word_timing(pcm, w["start"], w["end"], start, refine_onsets),
                 confidence=round(float(w["probability"]), 3)) for w in alignment
        ]})
    return sorted(candidates, key=lambda c: c["score"], reverse=True)


def trim_quiet_lead(pcm, start, end):
    # Whisper sometimes assigns the rest before a sung entrance to its first word.
    samples = pcm[round(start*16000):round(end*16000)]
    blocks = samples[:len(samples)//160*160].reshape(-1, 160)
    if len(blocks) < 15:
        return start
    rms = np.sqrt(np.mean(blocks * blocks, axis=1))
    # A quiet consonant is still speech. A threshold relative to a later loud
    # vowel moved real onsets by hundreds of milliseconds.
    active = rms > 0.001
    sustained = np.flatnonzero(np.convolve(active.astype(int), np.ones(4), mode="valid") == 4)
    if len(sustained) and sustained[0] >= 8:
        return start + (int(sustained[0]) - 2) * .01
    return start


def word_timing(pcm, start, end, origin, vocals):
    hint = trim_quiet_lead(pcm, start, end) if vocals else start
    return {'start': round(origin + start, 3), 'end': round(origin + end, 3),
            'onset_range': [round(origin + start, 3), round(origin + hint, 3)]}


def write_vocal_audio(file, pcm, start):
    """Keep exactly the selected clock; only apply a documented scalar gain."""
    target = Path(file)
    target.parent.mkdir(parents=True, exist_ok=True)
    peak = float(np.max(np.abs(pcm))) if len(pcm) else 0
    gain = .95 / peak if peak > 0 else 1
    samples = np.rint(np.clip(pcm * gain, -1, 1) * 32767).astype('<i2')
    with tempfile.NamedTemporaryFile(dir=target.parent, suffix='.wav', delete=False) as temporary:
        name = temporary.name
    try:
        with wav_file.open(name, 'wb') as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(16000)
            output.writeframes(samples.tobytes())
        Path(name).replace(target)
    finally:
        Path(name).unlink(missing_ok=True)
    return {'file': str(target), 'sample_rate': 16000, 'channels': 1, 'frames': len(samples),
            'duration': len(samples) / 16000, 'source_start': start,
            'peak_before_normalization': peak, 'normalization_gain': gain,
            'method': 'MDX vocal residual; scalar normalization only, no stretch or time shift'}


def recognize(file, start, end, language, mode, cache, phrases, prepared_file=None):
    # Listen across cuts so a boundary in the middle of a word doesn't erase its context.
    origin = max(0, start - 3)
    wave = decode_window(file, origin, end + 3)
    if mode == "vocals":
        wave = separate_vocals(wave, cache)
    mono = av.AudioFrame.from_ndarray(wave.mean(axis=0, keepdims=True), format="fltp", layout="mono")
    mono.sample_rate = 44100
    resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
    pcm = np.concatenate([f.to_ndarray().ravel() for f in resampler.resample(mono) + resampler.resample(None)])
    if np.max(np.abs(pcm)) < 1e-4:
        return {"language": language, "words": []}
    revision = "846f74797293e5f605d509a6ab5395a1f2f2874e"
    for name in ("config.json", "tokenizer.json", "vocabulary.json", "preprocessor_config.json", "model.bin"):
        file_path = model_file(cache, "Zoont/faster-whisper-large-v3-turbo-int8-ct2", revision, name)
    model = WhisperModel(str(Path(file_path).parent), device="cpu", compute_type="int8", cpu_threads=4)
    segments, info = model.transcribe(pcm, language=None if language == "auto" else language,
                                      word_timestamps=True, condition_on_previous_text=False, beam_size=5,
                                      temperature=0, vad_filter=False)
    words = [
        dict(text=w.word, **word_timing(pcm, w.start, w.end, origin, mode == "vocals"),
             confidence=round(w.probability, 3))
        for segment in segments for w in segment.words or []
        if w.word.strip() and w.end > w.start and origin + w.end > start and origin + w.start < end
        and w.word.strip().casefold().strip(".,!") not in {"[music]", "(music)", "♪", "♫"}
    ]
    result = {"language": info.language, "words": words}
    selected = pcm[round((start-origin)*16000):round((end-origin)*16000)]
    if prepared_file:
        if mode != 'vocals' or Path(prepared_file).resolve() == Path(file).resolve():
            raise ValueError('诊断音轨必须来自分离人声，并另存文件')
        result['prepared_audio'] = write_vocal_audio(prepared_file, selected, start)
    if phrases:
        result["candidates"] = compare_phrases(model, selected, info.language, phrases, start, mode == "vocals")
    return result


if __name__ == "__main__":
    _, file, start, end, language, mode, cache, *args = sys.argv
    print(json.dumps(recognize(file, float(start), float(end), language, mode, cache,
                               json.loads(args[0]) if args else [], args[1] if len(args) > 1 and args[1] else None), ensure_ascii=False))
