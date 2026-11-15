"""Tests for timed_transcript.py: VAD parity with the Node kit, WAV reading, formats, and a fake HTTP API."""

from __future__ import annotations

import json
import math
import os
import shutil
import struct
import sys
import threading
import unittest
from array import array
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import timed_transcript as tt  # noqa: E402


def synth(parts: list[tuple[str, float]], rate: int = 16_000, snr_db: float | None = None, level: float = 0.3) -> tt.Pcm:
    """The same signal as test/signal.ts, sample for sample (float32 storage, MINSTD noise)."""
    total = sum(sec for _, sec in parts)
    samples = array("f", bytes(4 * round(total * rate)))
    i = 0
    for kind, sec in parts:
        n = round(sec * rate)
        if kind == "speech":
            for k in range(n):
                t = k / rate
                wobble = 0.6 + 0.4 * math.sin(2 * math.pi * 4 * t)
                tone = math.sin(2 * math.pi * 180 * t) + 0.5 * math.sin(2 * math.pi * 360 * t) + 0.25 * math.sin(2 * math.pi * 540 * t)
                samples[i + k] = (level / 1.75) * wobble * tone
        i += n
    if snr_db is not None:
        noise_rms = (level * 0.45) / 10 ** (snr_db / 20)
        scale = noise_rms * math.sqrt(12)
        seed = 12345
        for j in range(len(samples)):
            seed = (seed * 48271) % 2147483647
            samples[j] = samples[j] + scale * (seed / 2147483647 - 0.5)
    return tt.Pcm(samples, rate)


CLIP = [("pause", 0.5), ("speech", 1.2), ("pause", 0.6), ("speech", 2), ("pause", 1), ("speech", 0.8), ("pause", 0.4)]


class VadTest(unittest.TestCase):
    def test_bursts(self):
        self.assertEqual([(s.start, s.end) for s in tt.detect_speech(synth(CLIP))], [(0.49, 1.72), (2.29, 4.32), (5.29, 6.12)])

    def test_parity_fixture_matches_node(self):
        # Same fixture and numbers as the inline snapshot in test/vad.test.ts.
        pcm = synth([("pause", 0.42), ("speech", 1.37), ("pause", 0.51), ("speech", 0.9), ("pause", 0.33), ("speech", 2.2), ("pause", 0.7)], snr_db=15)
        self.assertEqual(tt.detect_speech(pcm), [
            tt.VadSegment(start=0.41, end=1.8, audio_start=0.21, audio_end=2),
            tt.VadSegment(start=2.29, end=5.72, audio_start=2.09, audio_end=5.92),
        ])

    def test_padding_clamped(self):
        pcm = synth([("pause", 0.1), ("speech", 1), ("pause", 0.42), ("speech", 1), ("pause", 0.05)])
        a, b = tt.detect_speech(pcm, pad_ms=300)
        self.assertEqual(a, tt.VadSegment(0.09, 1.12, 0, 1.315))
        self.assertEqual(b, tt.VadSegment(1.51, 2.54, 1.315, 2.57))

    def test_long_runs_are_cut_within_limit(self):
        segments = tt.detect_speech(synth([("pause", 0.5), ("speech", 9), ("pause", 0.2), ("speech", 9), ("pause", 0.5)]))
        self.assertEqual(len(segments), 2)
        self.assertTrue(9.5 <= segments[0].end <= 9.7)
        self.assertEqual(segments[0].end, segments[1].start)

    def test_hum_below_speech_band(self):
        pcm = synth([("pause", 0.5), ("speech", 1), ("pause", 0.8), ("speech", 1), ("pause", 0.5)])
        for i in range(len(pcm.samples)):
            pcm.samples[i] = pcm.samples[i] + 0.6 * math.sin(2 * math.pi * 50 * i / pcm.sample_rate)
        self.assertEqual([(s.start, s.end) for s in tt.detect_speech(pcm)], [(0.49, 1.51), (2.29, 3.31)])
        self.assertLess(len(tt.detect_speech(pcm, band=None)), 2)

    def test_odd_sample_rates_and_mostly_silent_files(self):
        for rate in (22_050, 11_025):
            (seg,) = tt.detect_speech(synth([("pause", 600), ("speech", 1), ("pause", 1)], rate=rate))
            self.assertLessEqual(abs(seg.start - 600), 0.03)
            self.assertLessEqual(abs(seg.end - 601), 0.03)
            self.assertLessEqual(seg.audio_end, 602)

    def test_rejects_sliver_limits(self):
        with self.assertRaisesRegex(ValueError, "max_segment_sec must be at least 1 s"):
            tt.detect_speech(synth([("speech", 0.5)]), max_segment_sec=0.001)

    def test_silence(self):
        self.assertEqual(tt.detect_speech(synth([("pause", 2)])), [])
        self.assertEqual(tt.detect_speech(tt.Pcm(array("f"), 16_000)), [])


class WavTest(unittest.TestCase):
    def test_round_trip_and_stereo(self):
        pcm = tt.Pcm(array("f", [0, 0.5, -0.5, 1, -1]), 16_000)
        back = tt.read_wav(tt.encode_wav16(pcm, 1, 4))
        self.assertEqual([round(x, 3) for x in back.samples], [0.5, -0.5, 1])
        data = struct.pack("<hhhh", 16384, 0, -32768, -32768)
        fmt = struct.pack("<HHIIHH", 1, 2, 8000, 32000, 4, 16)
        riff = b"WAVE" + b"fmt " + struct.pack("<I", 16) + fmt + b"LIST" + struct.pack("<I", 3) + b"odd\x00" + b"data" + struct.pack("<I", len(data)) + data
        stereo = tt.read_wav(b"RIFF" + struct.pack("<I", len(riff)) + riff)
        self.assertEqual(list(stereo.samples), [0.25, -1])

    def test_errors(self):
        with self.assertRaisesRegex(ValueError, "not a RIFF/WAVE"):
            tt.read_wav(b"ID3 nope nope")
        truncated = b"RIFF" + struct.pack("<I", 16) + b"WAVEfmt " + struct.pack("<I", 16) + b"\x01\x00\x01\x00"
        with self.assertRaises(tt.DecodeError) as bad:
            tt.decode_audio(truncated, ffmpeg="/nonexistent/ffmpeg")
        self.assertEqual(bad.exception.code, "bad_wav")
        with self.assertRaises(tt.DecodeError) as caught:
            tt.decode_audio(b"ID3\x04 fake mp3", ffmpeg="/nonexistent/ffmpeg")
        self.assertEqual(caught.exception.code, "needs_ffmpeg")

    @unittest.skipUnless(os.environ.get("FFMPEG") and shutil.which(os.environ["FFMPEG"]), "set FFMPEG to an ffmpeg binary")
    def test_ffmpeg_decode(self):
        import subprocess

        flac = subprocess.run([os.environ["FFMPEG"], "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                               "sine=frequency=440:duration=1.5:sample_rate=44100", "-c:a", "flac", "-f", "flac", "pipe:1"],
                              capture_output=True, check=True).stdout
        pcm = tt.decode_audio(flac, ffmpeg=os.environ["FFMPEG"])
        self.assertEqual(pcm.sample_rate, 16_000)
        self.assertTrue(23_900 < len(pcm.samples) < 24_100)


class FormatTest(unittest.TestCase):
    transcript = tt.TimedTranscript("First line. Second --> line.", 3725.5, [
        tt.TimedSegment(0, 0.42, 1.79, "First line."),
        tt.TimedSegment(1, 3661.2345, 3663, "Second -->\n\n line."),
    ], ["en"])

    def test_same_output_as_node(self):
        self.assertEqual(tt.timecode(3661.2345, ","), "01:01:01,235")
        self.assertEqual(tt.timecode(59.9996, "."), "00:01:00.000")
        self.assertEqual(tt.to_srt(self.transcript),
                         "1\n00:00:00,420 --> 00:00:01,790\nFirst line.\n\n2\n01:01:01,235 --> 01:01:03,000\nSecond -->\n line.\n")
        self.assertEqual(tt.to_vtt(self.transcript),
                         "WEBVTT\n\n00:00:00.420 --> 00:00:01.790\nFirst line.\n\n01:01:01.235 --> 01:01:03.000\nSecond --&gt;\n line.\n")
        tags = tt.TimedTranscript("", 1, [tt.TimedSegment(0, 0, 1, "I <3 R&D <b")])
        self.assertIn("\nI &lt;3 R&amp;D &lt;b\n", tt.to_vtt(tags))
        self.assertEqual(tt.to_verbose_json(self.transcript)["segments"][0], {"id": 0, "start": 0.42, "end": 1.79, "text": "First line."})


class FakeApi:
    """A stand-in for /v1/audio/transcriptions; `reply(request, index)` returns (status, headers, body)."""

    def __init__(self, reply):
        self.requests: list[dict] = []
        self.lock = threading.Lock()
        api = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                raw = self.rfile.read(int(self.headers["Content-Length"]))
                message = BytesParser(policy=HTTP).parsebytes(
                    b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + raw)
                fields: dict[str, list[str]] = {}
                file_name, seconds = "", 0.0
                for part in message.iter_parts():
                    name = part.get_param("name", header="content-disposition")
                    if part.get_filename():
                        file_name = part.get_filename()
                        pcm = tt.read_wav(part.get_payload(decode=True))
                        seconds = len(pcm.samples) / pcm.sample_rate
                    else:
                        fields.setdefault(name, []).append(part.get_payload(decode=True).decode())
                captured = {"path": self.path, "auth": self.headers["Authorization"], "fields": fields,
                            "file": file_name, "seconds": seconds}
                with api.lock:
                    api.requests.append(captured)
                    index = len(api.requests) - 1
                status, headers, body = reply(captured, index)
                payload = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                for key, value in {"Content-Type": "application/json", **headers}.items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class TranscribeTest(unittest.TestCase):
    def serve(self, reply):
        api = FakeApi(reply)
        self.addCleanup(api.close)
        return api

    def test_request_body_and_offsets(self):
        api = self.serve(lambda req, i: (200, {}, {"text": f" words in {req['file']} ", "languages": [{"code": "en"}]}))
        result = tt.transcribe_timed(synth(CLIP), api_key="test-key", base_url=api.base_url, languages=["en", "uz"], keywords=["Payme"])
        self.assertEqual([(s.id, s.start, s.end, s.text) for s in result.segments], [
            (0, 0.49, 1.72, "words in segment-0.wav"), (1, 2.29, 4.32, "words in segment-1.wav"), (2, 5.29, 6.12, "words in segment-2.wav")])
        self.assertEqual((result.duration, result.languages), (6.5, ["en"]))
        first = next(r for r in api.requests if r["file"] == "segment-0.wav")
        self.assertEqual(first["path"], "/v1/audio/transcriptions")
        self.assertEqual(first["auth"], "Bearer test-key")
        self.assertEqual(first["fields"], {"model": ["gpt-transcribe"], "response_format": ["json"],
                                           "languages[]": ["en", "uz"], "keywords[]": ["Payme"]})
        self.assertAlmostEqual(first["seconds"], 1.63, places=3)

    def test_retries_then_succeeds(self):
        def reply(req, i):
            if i == 0:
                return 429, {"Retry-After": "0"}, {"error": {"message": "slow down"}}
            if i == 1:
                return 503, {"Retry-After": "0"}, b""
            return 200, {}, {"text": "ok"}

        api = self.serve(reply)
        result = tt.transcribe_timed(synth(CLIP), api_key="k", base_url=api.base_url, concurrency=1)
        self.assertEqual(len(result.segments), 3)
        self.assertEqual(len(api.requests), 5)

    def test_400_fails_fast_with_api_message(self):
        api = self.serve(lambda req, i: (400, {}, {"error": {"message": "Unsupported value: 'srt'"}}))
        with self.assertRaises(tt.TranscribeError) as caught:
            tt.transcribe_timed(synth(CLIP), api_key="k", base_url=api.base_url, concurrency=1)
        self.assertEqual((caught.exception.status, caught.exception.segment), (400, 0))
        self.assertEqual(str(caught.exception), "segment 0: HTTP 400: Unsupported value: 'srt'")
        self.assertEqual(len(api.requests), 1)

    def test_empty_segments_dropped_and_silence_sends_nothing(self):
        api = self.serve(lambda req, i: (200, {}, {"text": " " if req["file"] == "segment-1.wav" else "x"}))
        result = tt.transcribe_timed(synth(CLIP), api_key="k", base_url=api.base_url)
        self.assertEqual([(s.id, s.start) for s in result.segments], [(0, 0.49), (1, 5.29)])
        before = len(api.requests)
        quiet = tt.transcribe_timed(synth([("pause", 2)]), api_key="k", base_url=api.base_url)
        self.assertEqual((quiet.segments, quiet.text, len(api.requests)), ([], "", before))

    def test_retry_after_zero_is_immediate(self):
        import time

        api = self.serve(lambda req, i: (429, {"Retry-After": "0"}, {}) if i < 3 else (200, {}, {"text": "ok"}))
        started = time.monotonic()
        tt.transcribe_timed(synth(CLIP), api_key="k", base_url=api.base_url, concurrency=1)
        self.assertLess(time.monotonic() - started, 0.5)

    def test_retries_a_dropped_connection_and_a_stalled_body(self):
        import socket

        calls = []
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        self.addCleanup(listener.close)

        def serve():
            while True:
                try:
                    conn, _ = listener.accept()
                except OSError:
                    return
                data = b""
                while b"\r\n\r\n" not in data:
                    data += conn.recv(65536)
                head, _, rest = data.partition(b"\r\n\r\n")
                length = int([l for l in head.split(b"\r\n") if l.lower().startswith(b"content-length")][0].split(b":")[1])
                while len(rest) < length:
                    rest += conn.recv(65536)
                calls.append(1)
                if len(calls) == 1:
                    conn.close()  # reset before any response
                    continue
                if len(calls) == 2:
                    conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"te")
                    threading.Timer(1.0, conn.close).start()  # body never finishes before the timeout
                    continue
                body = b'{"text": "ok"}'
                conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                             + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
                conn.close()

        threading.Thread(target=serve, daemon=True).start()
        one = synth([("pause", 0.3), ("speech", 1), ("pause", 0.3)])
        url = f"http://127.0.0.1:{listener.getsockname()[1]}/v1"
        result = tt.transcribe_timed(one, api_key="k", base_url=url, timeout=0.3)
        self.assertEqual([s.text for s in result.segments], ["ok"])
        self.assertEqual(len(calls), 3)

    def test_cancel_returns_without_waiting_for_the_request(self):
        import time

        gate = threading.Event()
        self.addCleanup(gate.set)
        api = self.serve(lambda req, i: (gate.wait(5), (200, {}, {"text": "late"}))[1])
        cancel = threading.Event()
        threading.Timer(0.2, cancel.set).start()
        started = time.monotonic()
        with self.assertRaisesRegex(tt.TranscribeError, "cancelled"):
            tt.transcribe_timed(synth(CLIP), api_key="k", base_url=api.base_url, cancel=cancel)
        self.assertLess(time.monotonic() - started, 1.5)

    def test_rejects_bad_concurrency(self):
        with self.assertRaises(ValueError):
            tt.transcribe_timed(synth(CLIP), api_key="k", concurrency=0)

    def test_needs_key(self):
        saved = os.environ.pop("OPENAI_API_KEY", None)
        try:
            with self.assertRaisesRegex(tt.TranscribeError, "no API key"):
                tt.transcribe_timed(synth(CLIP))
        finally:
            if saved is not None:
                os.environ["OPENAI_API_KEY"] = saved


if __name__ == "__main__":
    unittest.main()
