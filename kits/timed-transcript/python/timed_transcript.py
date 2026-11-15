"""Segment timestamps, SRT and VTT on gpt-transcribe (Python 3.10+, standard library only).

whisper-1 shuts down on 2027-02-26, and on gpt-transcribe ``timestamp_granularities`` is "only supported for
whisper-1". This module finds the speech with a local energy VAD, transcribes each segment as its own request and
puts the segment offsets on the text. It is the Python twin of ``src/`` and returns the same segment numbers.
"""

from __future__ import annotations

import http.client
import json
import math
import os
import random
import re
import shutil
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from array import array
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from pathlib import Path

DEFAULT_MODEL = "gpt-transcribe"
DEFAULT_BASE_URL = "https://api.openai.com/v1"
SILENT_DB = -100.0
SMOOTH = 1
ABOVE_FLOOR_DB = 3
BELOW_PEAK_DB = 36
DEFAULT_BAND = (250, 3500)
QUIET_WINDOW = 5
MIN_SEGMENT_LIMIT_SEC = 1
RETRY_STATUS = {408, 409, 429}


@dataclass
class Pcm:
    """Mono float samples in [-1, 1] (stored as float32, like the Node Float32Array)."""

    samples: array
    sample_rate: int


@dataclass(frozen=True)
class VadSegment:
    start: float
    end: float
    audio_start: float
    audio_end: float


@dataclass(frozen=True)
class TimedSegment:
    id: int
    start: float
    end: float
    text: str


@dataclass
class TimedTranscript:
    text: str
    duration: float
    segments: list[TimedSegment]
    languages: list[str] = field(default_factory=list)


class DecodeError(Exception):
    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.code = code  # needs_ffmpeg | ffmpeg_failed | bad_wav


class TranscribeError(Exception):
    def __init__(self, message: str, status: int | None = None, segment: int | None = None):
        super().__init__(message)
        self.status = status
        self.segment = segment


# --- audio -----------------------------------------------------------------------------------------------------


def is_wav(data: bytes) -> bool:
    return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"


def read_wav(data: bytes) -> Pcm:
    """RIFF/WAVE: integer PCM (8, 16, 24, 32 bit) or 32-bit float, any channel count (averaged to mono)."""
    try:
        return _read_wav(data)
    except struct.error as error:
        raise ValueError(f"WAV is truncated: {error}") from None


def _read_wav(data: bytes) -> Pcm:
    if not is_wav(data):
        raise ValueError("not a RIFF/WAVE file")
    fmt = None
    body = None
    pos = 12
    while pos + 8 <= len(data):
        chunk_id = data[pos : pos + 4]
        (size,) = struct.unpack_from("<I", data, pos + 4)
        start = pos + 8
        if chunk_id == b"fmt ":
            if size < 16:
                raise ValueError("WAV fmt chunk is too short")
            tag, channels, rate = struct.unpack_from("<HHI", data, start)
            (bits,) = struct.unpack_from("<H", data, start + 14)
            if tag == 0xFFFE and size >= 40:
                (tag,) = struct.unpack_from("<H", data, start + 24)
            fmt = (tag, channels, rate, bits)
        elif chunk_id == b"data":
            length = len(data) - start if size == 0 else min(size, len(data) - start)
            body = (start, length)
            break
        pos = start + size + (size % 2)
    if fmt is None:
        raise ValueError("WAV has no fmt chunk")
    if body is None:
        raise ValueError("WAV has no data chunk")
    tag, channels, rate, bits = fmt
    if channels < 1 or rate < 1:
        raise ValueError("WAV fmt chunk has no channels or sample rate")
    values = _sample_values(data[body[0] : body[0] + body[1]], tag, bits)
    frames = len(values) // channels
    if channels == 1:
        mono = array("f", values[:frames])
    else:
        mono = array("f", (sum(values[i * channels : (i + 1) * channels]) / channels for i in range(frames)))
    return Pcm(mono, rate)


def _sample_values(raw: bytes, tag: int, bits: int) -> list[float]:
    if tag == 3 and bits == 32:
        return list(array("f", raw[: len(raw) // 4 * 4]))
    if tag != 1:
        raise ValueError(f"unsupported WAV encoding (format tag {tag}, {bits} bit)")
    if bits == 8:
        return [(b - 128) / 128 for b in raw]
    if bits == 16:
        ints = array("h", raw[: len(raw) // 2 * 2])
        return [v / 32768 for v in ints]
    if bits == 24:
        n = len(raw) // 3
        return [int.from_bytes(raw[i * 3 : i * 3 + 3], "little", signed=True) / 8388608 for i in range(n)]
    if bits == 32:
        ints = array("i", raw[: len(raw) // 4 * 4])
        return [v / 2147483648 for v in ints]
    raise ValueError(f"unsupported WAV sample size: {bits} bit")


def encode_wav16(pcm: Pcm, start: float = 0, end: float | None = None) -> bytes:
    """16-bit mono WAV of samples[start, end)."""
    a = max(0, math.floor(start))
    b = len(pcm.samples) if end is None else min(len(pcm.samples), math.ceil(end))
    out = array("h")
    for s in pcm.samples[a:b] if b > a else []:
        s = max(-1.0, min(1.0, s))
        out.append(_round_half_away(s * 32768 if s < 0 else s * 32767))
    payload = out.tobytes()
    header = b"RIFF" + struct.pack("<I", 36 + len(payload)) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, 1, pcm.sample_rate, pcm.sample_rate * 2, 2, 16
    ) + b"data" + struct.pack("<I", len(payload))
    return header + payload


def _round_half_away(x: float) -> int:
    # JavaScript Math.round: halves go up.
    return math.floor(x + 0.5)


def decode_audio(source: str | os.PathLike | bytes, ffmpeg: str = "ffmpeg", sample_rate: int = 16_000) -> Pcm:
    """A path or file bytes to mono samples: WAV directly, anything else through ffmpeg."""
    data = source if isinstance(source, bytes) else Path(source).read_bytes()
    if is_wav(data):
        try:
            return read_wav(data)
        except ValueError as error:
            if not str(error).startswith("unsupported WAV"):
                raise DecodeError(f"can't read WAV: {error}", "bad_wav") from error
    if shutil.which(ffmpeg) is None:
        raise DecodeError(
            f"this isn't a PCM WAV and ffmpeg wasn't found ({ffmpeg}); install ffmpeg or pass a WAV", "needs_ffmpeg"
        )
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(sample_rate),
               "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"]
    done = subprocess.run(command, input=data, capture_output=True, check=False)
    if done.returncode != 0:
        message = done.stderr.decode(errors="replace").strip()[:300]
        raise DecodeError(f"ffmpeg exited with {done.returncode}: {message}", "ffmpeg_failed")
    ints = array("h", done.stdout[: len(done.stdout) // 2 * 2])
    return Pcm(array("f", (v / 32768 for v in ints)), sample_rate)


# --- VAD -------------------------------------------------------------------------------------------------------


def frame_energies(pcm: Pcm, frame_ms: float = 10, band: tuple[float, float] | None = DEFAULT_BAND) -> list[float]:
    """Frame energies in dBFS, averaged with one neighbour frame each side, after the speech-band filter."""
    size = frame_size(pcm.sample_rate, frame_ms)
    count = len(pcm.samples) // size
    signal = band_pass(pcm, *band) if band else list(pcm.samples)
    power = []
    for f in range(count):
        total = 0.0
        for s in signal[f * size : (f + 1) * size]:
            total += s * s
        power.append(total / size)
    out = []
    for f in range(count):
        window = power[max(0, f - SMOOTH) : min(count - 1, f + SMOOTH) + 1]
        total = 0.0
        for p in window:
            total += p
        out.append(max(SILENT_DB, 10 * math.log10(total / len(window))) if total > 0 else SILENT_DB)
    return out


def frame_size(sample_rate: int, frame_ms: float) -> int:
    """Samples per frame, rounded; times come from this (221 samples at 22.05 kHz), not from frame_ms."""
    return max(1, _round_half_away(sample_rate * frame_ms / 1000))


def band_pass(pcm: Pcm, low: float, high: float) -> list[float]:
    """2nd-order Butterworth high-pass then low-pass (RBJ cookbook biquads), as in src/vad.ts."""
    out = list(pcm.samples)
    if 0 < low < pcm.sample_rate / 2:
        _biquad(out, pcm.sample_rate, low, "highpass")
    if 0 < high < pcm.sample_rate / 2:
        _biquad(out, pcm.sample_rate, high, "lowpass")
    return out


def _biquad(x: list[float], rate: int, cutoff: float, kind: str) -> None:
    w = 2 * math.pi * cutoff / rate
    cos = math.cos(w)
    alpha = math.sin(w) / (2 * math.sqrt(0.5))
    a0 = 1 + alpha
    b1 = (1 - cos if kind == "lowpass" else -(1 + cos)) / a0
    b0 = ((1 - cos) / 2 if kind == "lowpass" else (1 + cos) / 2) / a0
    b2 = b0
    a1 = -2 * cos / a0
    a2 = (1 - alpha) / a0
    x1 = x2 = y1 = y2 = 0.0
    for i, x0 in enumerate(x):
        y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1, y2, y1 = x1, x0, y1, y0
        x[i] = y0


def threshold(db: list[float]) -> dict[str, float]:
    ordered = sorted(db)

    def at(p: float) -> float:
        return ordered[math.floor(p * (len(ordered) - 1))] if ordered else SILENT_DB

    floor = at(0.1)
    # The speech level comes from the frames above the floor margin, so a mostly silent file still has one.
    above = [x for x in ordered if x >= floor + ABOVE_FLOOR_DB]
    peak = above[math.floor(0.95 * (len(above) - 1))] if above else floor
    return {"floor": floor, "peak": peak, "threshold": max(floor + ABOVE_FLOOR_DB, peak - BELOW_PEAK_DB)}


def detect_speech(pcm: Pcm, frame_ms: float = 10, min_silence_ms: float = 350, min_speech_ms: float = 150,
                  pad_ms: float = 200, max_segment_sec: float = 15,
                  band: tuple[float, float] | None = DEFAULT_BAND) -> list[VadSegment]:
    """Speech segments by frame energy; the same algorithm and numbers as detectSpeech in src/vad.ts."""
    if not frame_ms > 0:
        raise ValueError("frame_ms must be a positive number")
    if not max_segment_sec >= MIN_SEGMENT_LIMIT_SEC:
        raise ValueError(f"max_segment_sec must be at least {MIN_SEGMENT_LIMIT_SEC} s")
    db = frame_energies(pcm, frame_ms, band)
    if not db:
        return []
    t = threshold(db)
    if t["peak"] <= SILENT_DB + 1:
        return []
    level = t["threshold"]
    runs: list[list[int]] = []
    f = 0
    while f < len(db):
        if db[f] < level:
            f += 1
            continue
        start = f
        while f < len(db) and db[f] >= level:
            f += 1
        runs.append([start, f])
    min_gap = _round_half_away(min_silence_ms / frame_ms)
    merged: list[list[int]] = []
    for run in runs:
        if merged and run[0] - merged[-1][1] < min_gap:
            merged[-1][1] = run[1]
        else:
            merged.append(list(run))
    min_run = _round_half_away(min_speech_ms / frame_ms)
    max_frames = _round_half_away(max_segment_sec * 1000 / frame_ms)
    cut: list[tuple[int, int]] = []
    for a, b in merged:
        if b - a >= min_run:
            _split_long(db, a, b, max_frames, cut)

    frame_sec = frame_size(pcm.sample_rate, frame_ms) / pcm.sample_rate
    total = len(pcm.samples) / pcm.sample_rate
    pad = pad_ms / 1000
    out = []
    for i, (a, b) in enumerate(cut):
        start, end = a * frame_sec, b * frame_sec
        prev_end = cut[i - 1][1] * frame_sec if i > 0 else 0
        next_start = cut[i + 1][0] * frame_sec if i < len(cut) - 1 else total
        out.append(VadSegment(
            start=_round3(start),
            end=_round3(end),
            audio_start=_round3(max(start - pad, (prev_end + start) / 2 if i > 0 else 0)),
            audio_end=_round3(min(end + pad, (end + next_start) / 2 if i < len(cut) - 1 else total)),
        ))
    return out


def _split_long(db: list[float], a: int, b: int, max_frames: int, out: list[tuple[int, int]]) -> None:
    start = a
    while b - start > max_frames:
        first = start + max_frames // 2
        last = min(start + max_frames, b - max_frames // 4) - QUIET_WINDOW
        best, best_energy = first, math.inf
        for f in range(first, last + 1):
            energy = 0.0
            for k in range(QUIET_WINDOW):
                energy += db[f + k] if f + k < len(db) else 0
            if energy < best_energy:
                best, best_energy = f, energy
        at = best + QUIET_WINDOW // 2
        out.append((start, at))
        start = at
    out.append((start, b))


def _round3(x: float) -> float:
    return math.floor(x * 1000 + 0.5) / 1000


# --- API -------------------------------------------------------------------------------------------------------


def transcribe_timed(source: str | os.PathLike | bytes | Pcm, *, api_key: str | None = None, model: str = DEFAULT_MODEL,
                     languages: list[str] | None = None, keywords: list[str] | None = None, prompt: str | None = None,
                     base_url: str = DEFAULT_BASE_URL, concurrency: int = 4, max_retries: int = 3,
                     timeout: float = 60, ffmpeg: str = "ffmpeg", cancel: threading.Event | None = None,
                     **vad_options: float) -> TimedTranscript:
    """whisper-1 ``verbose_json`` on gpt-transcribe: VAD segments, one request each, offsets on the text."""
    if not (isinstance(concurrency, int) and concurrency >= 1):
        raise ValueError("concurrency must be a whole number of at least 1")
    pcm = source if isinstance(source, Pcm) else decode_audio(source, ffmpeg)
    key = api_key or os.environ.get("OPENAI_API_KEY")
    if not key:
        raise TranscribeError("no API key: pass api_key or set OPENAI_API_KEY")
    found = detect_speech(pcm, **vad_options)
    stop = cancel or threading.Event()
    url = base_url.rstrip("/") + "/audio/transcriptions"
    fields: list[tuple[str, str]] = [("model", model), ("response_format", "json")]
    fields += [("languages[]", code) for code in languages or []]
    fields += [("keywords[]", word) for word in keywords or []]
    if prompt:
        fields.append(("prompt", prompt))

    def run(index: int) -> tuple[str, list[str]]:
        seg = found[index]
        wav = encode_wav16(pcm, seg.audio_start * pcm.sample_rate, seg.audio_end * pcm.sample_rate)
        return _post_segment(url, key, fields, wav, index, max_retries, timeout, stop)

    results: dict[int, tuple[str, list[str]]] = {}
    if found:
        # Not a with-block: on failure, return without waiting for requests already in flight (they end at
        # `timeout`); retries and queued segments stop through `stop`.
        pool = ThreadPoolExecutor(max_workers=min(concurrency, len(found)))
        try:
            futures = [pool.submit(run, i) for i in range(len(found))]
            while True:
                done, pending = wait(futures, timeout=0.2, return_when=FIRST_EXCEPTION)
                failed = [f for f in futures if f in done and f.exception() is not None]
                if failed:
                    stop.set()
                    # The lowest segment number, as in Node, so the error doesn't depend on thread timing.
                    raise failed[0].exception()  # type: ignore[misc]
                if not pending:
                    break
                if stop.is_set():
                    raise TranscribeError("cancelled")
            results = {i: f.result() for i, f in enumerate(futures)}
        finally:
            pool.shutdown(wait=False, cancel_futures=True)

    segments: list[TimedSegment] = []
    seen: list[str] = []
    for i, seg in enumerate(found):
        text, codes = results[i]
        seen += [c for c in codes if c not in seen]
        if text:
            segments.append(TimedSegment(len(segments), seg.start, seg.end, text))
    return TimedTranscript(
        text=" ".join(s.text for s in segments),
        duration=_round3(len(pcm.samples) / pcm.sample_rate),
        segments=segments,
        languages=seen,
    )


def _post_segment(url: str, key: str, fields: list[tuple[str, str]], wav: bytes, index: int, max_retries: int,
                  timeout: float, stop: threading.Event) -> tuple[str, list[str]]:
    body, content_type = _multipart(fields, ("file", f"segment-{index}.wav", "audio/wav", wav))
    attempt = 0
    while True:
        if stop.is_set():
            raise TranscribeError(f"segment {index}: cancelled", segment=index)
        request = urllib.request.Request(url, data=body, method="POST", headers={
            "Authorization": f"Bearer {key}", "Content-Type": content_type})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read()
            try:
                data = json.loads(raw)
            except ValueError:
                raise TranscribeError(f"segment {index}: response isn't JSON: {raw[:200]!r}", 200, index) from None
            text = data.get("text")
            if not isinstance(text, str):
                raise TranscribeError(f"segment {index}: response has no text", 200, index)
            codes = [l.get("code") for l in data.get("languages") or [] if isinstance(l.get("code"), str)]
            return text.strip(), codes
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")
            if (error.code in RETRY_STATUS or error.code >= 500) and attempt < max_retries:
                wait_for = _retry_after(error.headers.get("retry-after"))
                _sleep(_backoff(attempt) if wait_for is None else wait_for, stop)
                attempt += 1
                continue
            raise TranscribeError(f"segment {index}: HTTP {error.code}: {_api_message(detail)}", error.code, index) from None
        except (OSError, http.client.HTTPException) as error:
            # URLError, timeouts and resets are OSErrors; IncompleteRead is an HTTPException.
            if attempt >= max_retries:
                raise TranscribeError(f"segment {index}: request failed: {error}", segment=index) from error
            _sleep(_backoff(attempt), stop)
            attempt += 1


def _multipart(fields: list[tuple[str, str]], file: tuple[str, str, str, bytes]) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    name, filename, mime, data = file
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                 f"Content-Type: {mime}\r\n\r\n".encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def _backoff(attempt: int) -> float:
    return 0.5 * 2**attempt * (0.75 + random.random() * 0.5)


def _retry_after(value: str | None) -> float | None:
    """Seconds or an HTTP date, capped at 30 s."""
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            seconds = parsedate_to_datetime(value).timestamp() - time.time()
        except (TypeError, ValueError):
            return None
    return min(max(seconds, 0.0), 30.0)


def _sleep(seconds: float, stop: threading.Event) -> None:
    if stop.wait(seconds):
        raise TranscribeError("cancelled")


def _api_message(body: str) -> str:
    try:
        message = json.loads(body).get("error", {}).get("message")
        if isinstance(message, str):
            return message
    except (ValueError, AttributeError):
        pass
    return body[:300] or "(empty body)"


# --- formats ---------------------------------------------------------------------------------------------------


def timecode(seconds: float, separator: str) -> str:
    ms = max(0, math.floor(seconds * 1000 + 0.5))
    h, m, s = ms // 3_600_000, ms % 3_600_000 // 60_000, ms % 60_000 // 1000
    return f"{h:02d}:{m:02d}:{s:02d}{separator}{ms % 1000:03d}"


def _cue_text(text: str) -> str:
    return re.sub(r"\n{2,}", "\n", text.replace("\r\n", "\n").replace("\r", "\n")).strip()


def to_srt(transcript: TimedTranscript) -> str:
    return "\n".join(
        f"{i + 1}\n{timecode(s.start, ',')} --> {timecode(s.end, ',')}\n{_cue_text(s.text)}\n"
        for i, s in enumerate(transcript.segments)
    )


def to_vtt(transcript: TimedTranscript) -> str:
    cues = [f"{timecode(s.start, '.')} --> {timecode(s.end, '.')}\n{_vtt_escape(_cue_text(s.text))}\n"
            for s in transcript.segments]
    return "\n".join(["WEBVTT\n", *cues])


def _vtt_escape(text: str) -> str:
    # In WebVTT cue text '&' starts an entity and '<' a tag; escaping '>' also covers a stray '-->'.
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def to_verbose_json(transcript: TimedTranscript) -> dict:
    """The whisper-1 verbose_json fields this module can fill; no tokens, logprobs, no_speech_prob or words."""
    return {
        "task": "transcribe",
        "language": transcript.languages[0] if transcript.languages else "",
        "duration": transcript.duration,
        "text": transcript.text,
        "segments": [{"id": s.id, "start": s.start, "end": s.end, "text": s.text} for s in transcript.segments],
    }
