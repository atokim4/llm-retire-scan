"""Tests against a local fake Realtime server (same scenarios as ../test/speak.test.ts). No network, no API key."""

import asyncio
import base64
import io
import json
import math
import struct
import wave
from http import HTTPStatus

import pytest
import websockets

import speak_realtime as sr

KEY = "test-key-not-real"
BASE = {"response_id": "resp_1", "item_id": "item_1", "output_index": 0, "content_index": 0}


def tone() -> bytes:
    return b"".join(struct.pack("<h", round(8000 * math.sin(2 * math.pi * 440 * i / 24000))) for i in range(12000))


def reply(pcm: bytes, transcript: str, status: str = "completed") -> list[dict]:
    events = [{"type": "response.created", "response": {"id": "resp_1", "status": "in_progress"}}]
    events += [
        {"type": "response.output_audio.delta", **BASE, "delta": base64.b64encode(pcm[i : i + 4800]).decode()}
        for i in range(0, len(pcm), 4800)
    ]
    events.append({"type": "response.output_audio_transcript.delta", **BASE, "delta": transcript})
    details = {} if status == "completed" else {"status_details": {"type": status, "reason": "max_output_tokens"}}
    events.append({"type": "response.done", "response": {"id": "resp_1", "status": status, **details}})
    return events


async def with_server(script, call, reject_status=None):
    """Runs a fake server; `script(ws)` is awaited after response.create. Returns (result of call(url), state)."""
    state = {"received": [], "path": None, "auth": None}

    async def handler(ws):
        state["path"] = ws.request.path
        state["auth"] = ws.request.headers.get("Authorization")
        await ws.send(json.dumps({"type": "session.created", "session": {"type": "realtime"}}))
        async for frame in ws:
            event = json.loads(frame)
            state["received"].append(event)
            if event["type"] == "response.create":
                await script(ws)

    def process_request(connection, request):
        if reject_status:
            return connection.respond(HTTPStatus(reject_status), "no\n")
        return None

    async with websockets.serve(handler, "127.0.0.1", 0, process_request=process_request) as server:
        port = server.sockets[0].getsockname()[1]
        return await call(f"ws://127.0.0.1:{port}/v1/realtime"), state


def sends(events):
    async def script(ws):
        for e in events:
            await ws.send(json.dumps(e))

    return script


def run(coro):
    return asyncio.run(coro)


def error_of(script, reject_status=None, **kwargs) -> sr.SpeakError:
    async def call(url):
        with pytest.raises(sr.SpeakError) as info:
            await sr.speak("Hi", api_key=KEY, url=url, **kwargs)
        return info.value

    return run(with_server(script, call, reject_status))[0]


def test_happy_path_sends_three_events_and_returns_wav():
    pcm = tone()
    result, state = run(
        with_server(
            sends(reply(pcm, "Your order has shipped.")),
            lambda url: sr.speak("Your order has shipped.", voice="cedar", api_key=KEY, url=url),
        )
    )
    assert result.pcm == pcm
    assert result.verbatim
    with wave.open(io.BytesIO(result.wav)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()) == (1, 2, 24000, 12000)
    assert state["path"] == "/v1/realtime?model=gpt-realtime-2.1-mini"
    assert state["auth"] == f"Bearer {KEY}"
    assert state["received"] == sr.speak_events("Your order has shipped.", "cedar")
    assert state["received"][0]["session"]["audio"]["output"] == {
        "format": {"type": "audio/pcm", "rate": 24000},
        "voice": "cedar",
    }


def test_matches_node_event_shapes():
    """The Node test pins the exact JSON; the Python events must be the same objects."""
    events = sr.speak_events("Hi", "marin", "calm", 0.9)
    assert [e["type"] for e in events] == ["session.update", "conversation.item.create", "response.create"]
    assert events[0]["session"]["instructions"].endswith("\n\nDelivery: calm")
    assert events[0]["session"]["audio"]["output"]["speed"] == 0.9


def test_not_verbatim():
    result, _ = run(with_server(sends(reply(tone(), "Sure! Hi")), lambda url: sr.speak("Hi", api_key=KEY, url=url)))
    assert not result.verbatim


def test_server_error_event():
    e = error_of(
        sends(
            [
                {
                    "type": "error",
                    "error": {
                        "type": "invalid_request_error",
                        "code": "invalid_value",
                        "message": "Invalid value: 'nova'",
                    },
                }
            ]
        )
    )
    assert (str(e), e.code) == ("Invalid value: 'nova'", "invalid_value")


def test_incomplete_response():
    e = error_of(sends(reply(tone(), "Hi", "incomplete")))
    assert e.code == "response_incomplete" and "max_output_tokens" in str(e)


def test_early_close():
    async def script(ws):
        await ws.close(1011, "server going away")

    e = error_of(script)
    assert e.code == "closed_early" and "1011" in str(e)


def test_timeout():
    async def script(ws):
        await asyncio.sleep(1)

    assert error_of(script, timeout=0.2).code == "timeout"


def test_handshake_rejected():
    assert error_of(sends([]), reject_status=401).code == "http_401"


def test_no_audio():
    assert error_of(sends(reply(b"", ""))).code == "no_audio"


def test_input_checks(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    for kwargs, code in [
        ({"text": " ", "api_key": KEY}, "empty_text"),
        ({"text": "Hi"}, "no_api_key"),
        ({"text": "Hi", "api_key": KEY, "speed": 2.0}, "bad_speed"),
    ]:
        with pytest.raises(sr.SpeakError) as info:
            run(sr.speak(**kwargs))
        assert info.value.code == code


def test_from_speech_params():
    kwargs, fmt = sr.from_speech_params(
        {
            "model": "gpt-4o-mini-tts",
            "input": "Hello",
            "voice": "coral",
            "instructions": "cheerful",
            "response_format": "wav",
            "speed": 1.2,
        }
    )
    assert fmt == "wav"
    assert kwargs == {"text": "Hello", "voice": "coral", "style": "cheerful", "speed": 1.2}
    assert sr.from_speech_params({"input": "Hi", "voice": "ash", "response_format": "pcm"})[1] == "pcm"
    with pytest.raises(sr.SpeakError) as info:
        sr.from_speech_params({"model": "tts-1", "input": "Hello", "voice": "nova", "speed": 3})
    message = str(info.value)
    assert 'voice "nova"' in message and 'response_format "mp3"' in message and "speed 3" in message
    with pytest.raises(sr.SpeakError, match='"mp3"'):
        sr.from_speech_params({"input": "Hi", "voice": "ash", "response_format": None})


def test_mapped_params_go_straight_into_speak():
    kwargs, _ = sr.from_speech_params({"input": "Hi", "voice": "ash", "response_format": "wav"})
    result, _ = run(with_server(sends(reply(tone(), "Hi")), lambda url: sr.speak(**kwargs, api_key=KEY, url=url)))
    assert result.verbatim


def test_odd_audio_and_malformed_events():
    assert error_of(sends(reply(b"abc", "Hi"))).code == "bad_audio"
    for event in [{"type": "response.output_audio.delta"}, {"type": "error"}, {"type": "response.done"}]:
        assert error_of(sends([event])).code == "bad_event"


def test_handshake_that_never_completes_hits_the_timeout():
    async def main():
        writers = []

        async def hold(reader, writer):
            writers.append(writer)  # accept TCP, never answer the upgrade

        server = await asyncio.start_server(hold, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        try:
            with pytest.raises(sr.SpeakError) as info:
                await sr.speak("Hi", api_key=KEY, url=f"ws://127.0.0.1:{port}/v1/realtime", timeout=0.3)
            return info.value
        finally:
            for writer in writers:
                writer.close()
            server.close()
            await server.wait_closed()

    assert run(main()).code == "timeout"


def test_odd_pcm():
    with pytest.raises(ValueError):
        sr.pcm16_to_wav(b"abc")
