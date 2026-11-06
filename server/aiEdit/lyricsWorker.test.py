import importlib.util
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

spec = importlib.util.spec_from_file_location('lyrics_worker', Path(__file__).with_name('lyricsWorker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class VocalTimingTests(unittest.TestCase):
    def test_soft_consonant_before_loud_vowel_is_not_erased(self):
        pcm = np.sin(np.arange(8000) * 2 * np.pi * 180 / 16000).astype(np.float32)
        pcm[:3200] *= .004
        pcm[3200:] *= .12
        self.assertEqual(worker.trim_quiet_lead(pcm, 0, .5), 0)
        self.assertEqual(worker.word_timing(pcm, 0, .5, 16, True)['start'], 16)

    def test_silence_hint_is_an_interval_and_never_overwrites_asr_time(self):
        pcm = np.zeros(8000, dtype=np.float32)
        pcm[3200:] = .1 * np.sin(np.arange(4800) * 2 * np.pi * 180 / 16000)
        result = worker.word_timing(pcm, 0, .5, 16, True)
        self.assertEqual(result['start'], 16)
        self.assertAlmostEqual(result['onset_range'][1], 16.18)

    def test_prepared_audio_preserves_sample_clock_and_uses_only_scalar_gain(self):
        pcm = np.zeros(16000, dtype=np.float32)
        pcm[4000:8000] = .05 * np.sin(np.arange(4000) * 2 * np.pi * 180 / 16000)
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'vocals.wav'
            result = worker.write_vocal_audio(file, pcm, 16)
            with wave.open(str(file), 'rb') as source:
                actual = np.frombuffer(source.readframes(source.getnframes()), dtype='<i2')
                self.assertEqual(source.getframerate(), 16000)
                self.assertEqual(source.getnchannels(), 1)
            self.assertEqual(len(actual), len(pcm))
            self.assertFalse(np.any(actual[:4000]))
            self.assertFalse(np.any(actual[8000:]))
            self.assertAlmostEqual(np.corrcoef(actual, pcm)[0, 1], 1, places=8)
            self.assertEqual(result['source_start'], 16)


if __name__ == '__main__':
    unittest.main()
