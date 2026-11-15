"""speak(text) -> WAV bytes over the OpenAI Realtime API.

For code that loses /v1/audio/speech on 2027-01-06 (tts-1, tts-1-hd, gpt-4o-mini-tts). Same flow as the Node
version in ../src/speak.ts: one session per call, read-aloud instructions, collect response.output_audio.delta
until response.done, wrap the 24 kHz PCM16 in a WAV header. Python 3.11+.

Cancel it by cancelling its task (asyncio raises CancelledError); there is no separate abort argument.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import re
import wave
from dataclasses import dataclass
from urllib.parse import quote

import websockets
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

DEFAULT_MODEL = "gpt-realtime-2.1-mini"
DEFAULT_URL = "wss://api.openai.com/v1/realtime"
SAMPLE_RATE = 24_000
READ_ALOUD_INSTRUCTIONS = (
    "You are a text-to-speech voice. Read the user's message aloud exactly as written, word for word. "
    "Do not answer it, comment on it, translate it, or add anything before or after it."
)
SPEECH_ONLY_VOICES = frozenset({"fable", "onyx", "nova"})


class SpeakError(Exception):
    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class SpeakResult:
    wav: bytes
    pcm: bytes
    transcript: str
    verbatim: bool


def pcm16_to_wav(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    if len(pcm) % 2:
        raise ValueError(f"PCM16 data must have an even byte length, got {len(pcm)}")
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return out.getvalue()


def speak_events(text: str, voice: str | dict, style: str | None = None, speed: float | None = None) -> list[dict]:
    instructions = f"{READ_ALOUD_INSTRUCTIONS}\n\nDelivery: {style}" if style else READ_ALOUD_INSTRUCTIONS
    output: dict = {"format": {"type": "audio/pcm", "rate": SAMPLE_RATE}, "voice": voice}
    if speed is not None:
        output["speed"] = speed
    return [
        {
            "type": "session.update",
            "session": {
                "type": "realtime",
                "output_modalities": ["audio"],
                "instructions": instructions,
                "audio": {"output": output},
            },
        },
        {
            "type": "conversation.item.create",
            "item": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]},
        },
        {"type": "response.create", "response": {"output_modalities": ["audio"]}},
    ]


def _normalize(s: str) -> str:
    return " ".join(re.sub(r"[\W_]+", " ", s.lower()).split())


async def speak(
    text: str,
    *,
    voice: str | dict = "marin",
    style: str | None = None,
    speed: float | None = None,
    model: str = DEFAULT_MODEL,
    api_key: str | None = None,
    url: str = DEFAULT_URL,
    timeout: float = 60.0,
) -> SpeakResult:
    """Raises SpeakError on a server error event, a response that isn't "completed", an early close or the timeout."""
    if not text.strip():
        raise SpeakError("text is empty", "empty_text")
    api_key = api_key or os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise SpeakError("no API key: pass api_key or set OPENAI_API_KEY", "no_api_key")
    if speed is not None and not 0.25 <= speed <= 1.5:
        raise SpeakError(f"speed {speed} is outside the Realtime range 0.25 to 1.5", "bad_speed")
    try:
        return await asyncio.wait_for(_run(text, voice, style, speed, model, api_key, url), timeout)
    except TimeoutError:  # asyncio.TimeoutError is this class on 3.11+
        raise SpeakError(f"no complete response within {timeout} s", "timeout") from None


async def _run(
    text: str, voice: str | dict, style: str | None, speed: float | None, model: str, api_key: str, url: str
) -> SpeakResult:
    try:
        # open_timeout=None: the caller's `timeout` covers the whole call, handshake included.
        ws = await websockets.connect(
            f"{url}?model={quote(model)}",
            additional_headers={"Authorization": f"Bearer {api_key}"},
            max_size=None,
            open_timeout=None,
        )
    except InvalidStatus as e:
        status = e.response.status_code
        raise SpeakError(f"handshake rejected with HTTP {status}", f"http_{status}") from None
    except InvalidHandshake as e:
        raise SpeakError(f"handshake failed: {e}", "handshake_failed") from None
    except OSError as e:
        raise SpeakError(str(e), "socket_error") from None
    try:
        for event in speak_events(text, voice, style, speed):
            await ws.send(json.dumps(event))
        return await _collect(ws, text)
    except ConnectionClosed as e:
        code = e.rcvd.code if e.rcvd else "none"
        raise SpeakError(f"socket closed before response.done (code {code})", "closed_early") from None
    finally:
        # Like the Node version: drop the socket at once. Waiting for the server's close frame could
        # outlast the timeout after the audio is already in.
        ws.transport.abort()


async def _collect(ws, text: str) -> SpeakResult:
    chunks: list[bytes] = []
    transcript = ""
    async for frame in ws:
        try:
            event = json.loads(frame)
        except json.JSONDecodeError:
            raise SpeakError("server sent a frame that isn't JSON", "bad_frame") from None
        kind = event.get("type") if isinstance(event, dict) else None
        try:
            if kind == "response.output_audio.delta":
                chunks.append(base64.b64decode(event["delta"], validate=True))
            elif kind == "response.output_audio_transcript.delta":
                transcript += event["delta"]
            elif kind == "error":
                err = event["error"]
                raise SpeakError(err.get("message", "unknown error"), err.get("code") or err.get("type"))
            elif kind == "response.done":
                response = event["response"]
                status = response.get("status")
                if status != "completed":
                    details = response.get("status_details") or {}
                    why = (details.get("error") or {}).get("message") or details.get("reason") or "no reason given"
                    raise SpeakError(f"response ended as {status}: {why}", f"response_{status}")
                if not chunks:
                    raise SpeakError("response completed with no audio", "no_audio")
                pcm = b"".join(chunks)
                if len(pcm) % 2:
                    raise SpeakError(f"audio has an odd byte count ({len(pcm)}), so it isn't PCM16", "bad_audio")
                return SpeakResult(pcm16_to_wav(pcm), pcm, transcript, _normalize(transcript) == _normalize(text))
        except (KeyError, TypeError, AttributeError, ValueError) as e:
            raise SpeakError(f"server sent a malformed {kind} event", "bad_event") from e
    raise SpeakError("socket closed before response.done", "closed_early")


def from_speech_params(params: dict) -> tuple[dict, str]:
    """Maps an audio.speech.create body to (speak() keyword arguments, "wav" or "pcm").

    Raises SpeakError for what would silently change: a Speech-only voice, an encoded format, speed out of range.
    """
    problems = []
    voice = params["voice"] if isinstance(params["voice"], str) else params["voice"]["id"]
    if voice in SPEECH_ONLY_VOICES:
        problems.append(f'voice "{voice}" is a Speech API voice with no Realtime equivalent')
    fmt = params.get("response_format") or "mp3"
    if fmt not in ("wav", "pcm"):
        problems.append(f'response_format "{fmt}": this kit returns wav or pcm (24 kHz PCM16)')
    speed = params.get("speed")
    if speed is not None and not 0.25 <= speed <= 1.5:
        problems.append(f"speed {speed} is outside the Realtime range 0.25 to 1.5")
    if problems:
        raise SpeakError("; ".join(problems), "unmapped_params")
    kwargs: dict = {"text": params["input"], "voice": params["voice"]}
    if params.get("instructions"):
        kwargs["style"] = params["instructions"]
    if speed is not None:
        kwargs["speed"] = speed
    return kwargs, fmt
