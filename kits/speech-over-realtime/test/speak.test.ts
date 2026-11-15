import { afterEach, describe, expect, it } from "vitest";
import { fromSpeechParams, pcm16ToWav, READ_ALOUD_INSTRUCTIONS, speak, SpeakError } from "../src/index.ts";
import { reply, sendError, startFakeServer, type FakeServer } from "./fake-server.ts";

const KEY = "test-key-not-real";
let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** 0.5 s of a 440 Hz tone at 24 kHz, PCM16 LE. */
function tone(): Buffer {
  const pcm = Buffer.alloc(24_000);
  for (let i = 0; i < 12_000; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24_000)), i * 2);
  return pcm;
}

async function rejection(promise: Promise<unknown>): Promise<SpeakError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(SpeakError);
  return error as SpeakError;
}

describe("speak", () => {
  it("sends session.update, the text item and response.create, then returns the joined audio as WAV", async () => {
    const pcm = tone();
    server = await startFakeServer((ws) => reply(ws, pcm, "Your order has shipped."));
    const result = await speak({ text: "Your order has shipped.", voice: "cedar", apiKey: KEY, url: server.url });

    expect(result.pcm.equals(pcm)).toBe(true);
    expect(result.wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(result.wav.readUInt32LE(24)).toBe(24_000);
    expect(result.wav.length).toBe(44 + pcm.length);
    expect(result.verbatim).toBe(true);

    const req = server.requests[0]!;
    expect(req.url).toBe("/v1/realtime?model=gpt-realtime-2.1-mini");
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(server.received).toEqual([
      {
        type: "session.update",
        session: {
          type: "realtime",
          output_modalities: ["audio"],
          instructions: READ_ALOUD_INSTRUCTIONS,
          audio: { output: { format: { type: "audio/pcm", rate: 24_000 }, voice: "cedar" } },
        },
      },
      {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: "Your order has shipped." }] },
      },
      { type: "response.create", response: { output_modalities: ["audio"] } },
    ]);
  });

  it("flags a reply that wasn't read word for word", async () => {
    server = await startFakeServer((ws) => reply(ws, tone(), "Sure! Your order has shipped."));
    const result = await speak({ text: "Your order has shipped.", apiKey: KEY, url: server.url });
    expect(result.verbatim).toBe(false);
    expect(result.transcript).toBe("Sure! Your order has shipped.");
  });

  it("passes style and speed into the session", async () => {
    server = await startFakeServer((ws) => reply(ws, tone(), "Hi"));
    await speak({ text: "Hi", style: "calm and slow", speed: 0.9, apiKey: KEY, url: server.url });
    const session = (server.received[0] as { session: { instructions: string; audio: { output: { speed: number } } } })
      .session;
    expect(session.instructions).toBe(`${READ_ALOUD_INSTRUCTIONS}\n\nDelivery: calm and slow`);
    expect(session.audio.output.speed).toBe(0.9);
  });

  it("rejects with the server's error event", async () => {
    server = await startFakeServer((ws) => sendError(ws, "Invalid value: 'nova'", "invalid_value"));
    const error = await rejection(speak({ text: "Hi", apiKey: KEY, url: server.url }));
    expect(error.message).toBe("Invalid value: 'nova'");
    expect(error.code).toBe("invalid_value");
  });

  it("rejects a response that ends incomplete even when some audio arrived", async () => {
    server = await startFakeServer((ws) => reply(ws, tone(), "Hi", "incomplete"));
    const error = await rejection(speak({ text: "Hi", apiKey: KEY, url: server.url }));
    expect(error.code).toBe("response_incomplete");
    expect(error.message).toContain("max_output_tokens");
  });

  it("rejects when the socket closes before response.done", async () => {
    server = await startFakeServer((ws) => ws.close(1011, "server going away"));
    const error = await rejection(speak({ text: "Hi", apiKey: KEY, url: server.url }));
    expect(error.code).toBe("closed_early");
    expect(error.message).toContain("1011");
  });

  it("times out when the server never answers", async () => {
    server = await startFakeServer(() => {});
    const started = Date.now();
    const error = await rejection(speak({ text: "Hi", apiKey: KEY, url: server.url, timeoutMs: 200 }));
    expect(error.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("stops on abort", async () => {
    server = await startFakeServer(() => {});
    const controller = new AbortController();
    const pending = speak({ text: "Hi", apiKey: KEY, url: server.url, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect((await rejection(pending)).code).toBe("aborted");
  });

  it("reports a rejected handshake by HTTP status", async () => {
    server = await startFakeServer(() => {}, { rejectStatus: 401 });
    expect((await rejection(speak({ text: "Hi", apiKey: KEY, url: server.url }))).code).toBe("http_401");
  });

  it("refuses a completed response with no audio", async () => {
    server = await startFakeServer((ws) => reply(ws, Buffer.alloc(0), ""));
    expect((await rejection(speak({ text: "Hi", apiKey: KEY, url: server.url }))).code).toBe("no_audio");
  });

  it("rejects audio with an odd byte count instead of hanging", async () => {
    server = await startFakeServer((ws) => reply(ws, Buffer.from([1, 2, 3]), "Hi"));
    expect((await rejection(speak({ text: "Hi", apiKey: KEY, url: server.url, timeoutMs: 2000 }))).code).toBe("bad_audio");
  });

  it("rejects malformed events (no delta, no error object, no response) without crashing", async () => {
    for (const event of [{ type: "response.output_audio.delta" }, { type: "error" }, { type: "response.done" }]) {
      server = await startFakeServer((ws) => ws.send(JSON.stringify(event)));
      const error = await rejection(speak({ text: "Hi", apiKey: KEY, url: server.url, timeoutMs: 2000 }));
      expect(error.code).toBe("bad_event");
      await server.close();
      server = undefined;
    }
  });

  it("checks input before connecting", async () => {
    expect((await rejection(speak({ text: "  ", apiKey: KEY }))).code).toBe("empty_text");
    expect((await rejection(speak({ text: "Hi", apiKey: KEY, speed: 2 }))).code).toBe("bad_speed");
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect((await rejection(speak({ text: "Hi" }))).code).toBe("no_api_key");
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});

describe("fromSpeechParams", () => {
  it("maps a wav request with instructions and speed", () => {
    expect(fromSpeechParams({ model: "gpt-4o-mini-tts", input: "Hello", voice: "coral", instructions: "cheerful",
      response_format: "wav", speed: 1.2 })).toEqual({ text: "Hello", voice: "coral", style: "cheerful", speed: 1.2,
      format: "wav" });
  });

  it("refuses Speech-only voices, encoded formats (mp3 is the default) and out-of-range speed, all at once", () => {
    let message = "";
    try {
      fromSpeechParams({ model: "tts-1", input: "Hello", voice: "nova", speed: 3 });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('voice "nova"');
    expect(message).toContain('response_format "mp3"');
    expect(message).toContain("speed 3");
  });
});

describe("pcm16ToWav", () => {
  it("writes a 44-byte header with sizes that match the data", () => {
    const wav = pcm16ToWav(Buffer.alloc(10));
    expect(wav.length).toBe(54);
    expect(wav.readUInt32LE(4)).toBe(46);
    expect(wav.readUInt32LE(40)).toBe(10);
    expect(wav.readUInt16LE(34)).toBe(16);
  });

  it("rejects an odd byte count", () => {
    expect(() => pcm16ToWav(Buffer.alloc(3))).toThrow(/even byte length/);
  });
});
