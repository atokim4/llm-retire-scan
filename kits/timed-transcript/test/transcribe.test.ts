import { afterEach, describe, expect, it } from "vitest";
import { TranscribeError, transcribeTimed } from "../src/transcribe.ts";
import { toSrt } from "../src/format.ts";
import { startFakeApi } from "./fake-server.ts";
import { synth } from "./signal.ts";

// Three bursts at 0.5-1.7, 2.3-4.3, 5.3-6.1; the VAD reports 0.49-1.72, 2.29-4.32, 5.29-6.12 (see vad.test.ts).
const clip = () => synth([{ pause: 0.5 }, { speech: 1.2 }, { pause: 0.6 }, { speech: 2 }, { pause: 1 }, { speech: 0.8 }, { pause: 0.4 }]);
let api: Awaited<ReturnType<typeof startFakeApi>> | undefined;
afterEach(async () => { await api?.close(); api = undefined; });

describe("transcribeTimed against a fake API", () => {
  it("sends one gpt-transcribe request per segment and puts the VAD offsets on the text", async () => {
    api = await startFakeApi((req) => ({ body: { text: ` words in ${req.fileName} `, languages: [{ code: "en" }], usage: { type: "tokens" } } }));
    const result = await transcribeTimed(clip(), { apiKey: "test-key", baseUrl: api.baseUrl, languages: ["en", "uz"], keywords: ["Payme"] });

    expect(result.segments).toEqual([
      { id: 0, start: 0.49, end: 1.72, text: "words in segment-0.wav" },
      { id: 1, start: 2.29, end: 4.32, text: "words in segment-1.wav" },
      { id: 2, start: 5.29, end: 6.12, text: "words in segment-2.wav" },
    ]);
    expect(result.languages).toEqual(["en"]);
    expect(result.duration).toBe(6.5);
    expect(result.text).toBe("words in segment-0.wav words in segment-1.wav words in segment-2.wav");

    const first = api.requests.find((r) => r.fileName === "segment-0.wav");
    expect(first?.path).toBe("/v1/audio/transcriptions");
    expect(first?.authorization).toBe("Bearer test-key");
    expect(first?.fileType).toBe("audio/wav");
    // The body gpt-transcribe gets: no whisper-only fields, `languages[]` instead of `language`.
    expect(first?.fields).toEqual({ model: ["gpt-transcribe"], response_format: ["json"], "languages[]": ["en", "uz"], "keywords[]": ["Payme"] });
    // Each upload is the segment plus up to 200 ms padding (0.29-1.92 s here).
    expect(first?.seconds).toBeCloseTo(1.63, 3);
    expect(toSrt(result)).toContain("2\n00:00:02,290 --> 00:00:04,320\nwords in segment-1.wav\n");
  });

  it("keeps file order when answers come back out of order, and caps requests in flight", async () => {
    api = await startFakeApi(async (req) => {
      const delay = { "segment-0.wav": 120, "segment-1.wav": 60, "segment-2.wav": 0 }[req.fileName] ?? 0;
      await new Promise((r) => setTimeout(r, delay));
      return { body: { text: req.fileName } };
    });
    const result = await transcribeTimed(clip(), { apiKey: "k", baseUrl: api.baseUrl, concurrency: 2 });
    expect(result.segments.map((s) => s.text)).toEqual(["segment-0.wav", "segment-1.wav", "segment-2.wav"]);
    expect(api.maxInFlight()).toBe(2);
  });

  it("drops segments the model returns no words for, and renumbers", async () => {
    api = await startFakeApi((req) => ({ body: { text: req.fileName === "segment-1.wav" ? "  " : "x" } }));
    const result = await transcribeTimed(clip(), { apiKey: "k", baseUrl: api.baseUrl });
    expect(result.segments.map((s) => [s.id, s.start])).toEqual([[0, 0.49], [1, 5.29]]);
  });

  it("retries 429 and 5xx (honouring Retry-After), then succeeds", async () => {
    let calls = 0;
    api = await startFakeApi(() => {
      calls++;
      if (calls === 1) return { status: 429, headers: { "retry-after": "0" }, body: { error: { message: "slow down" } } };
      if (calls === 2) return { status: 503, headers: { "retry-after": "0" }, body: "" };
      return { body: { text: "ok" } };
    });
    const result = await transcribeTimed(clip(), { apiKey: "k", baseUrl: api.baseUrl, concurrency: 1 });
    expect(result.segments).toHaveLength(3);
    expect(api.requests).toHaveLength(5);
  });

  it("fails fast on a 400 with the API's message and the segment number", async () => {
    api = await startFakeApi(() => ({ status: 400, body: { error: { message: "Unsupported value: 'srt'" } } }));
    const error = await transcribeTimed(clip(), { apiKey: "k", baseUrl: api.baseUrl, concurrency: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranscribeError);
    expect((error as TranscribeError).status).toBe(400);
    expect((error as TranscribeError).segment).toBe(0);
    expect((error as Error).message).toBe("segment 0: HTTP 400: Unsupported value: 'srt'");
    expect(api.requests).toHaveLength(1);
  });

  it("gives up after maxRetries on a server that keeps failing", async () => {
    api = await startFakeApi(() => ({ status: 500, headers: { "retry-after": "0" }, body: "boom" }));
    const error = await transcribeTimed(clip(), { apiKey: "k", baseUrl: api.baseUrl, concurrency: 1, maxRetries: 1 }).catch((e: unknown) => e);
    expect((error as TranscribeError).status).toBe(500);
    expect(api.requests).toHaveLength(2);
  });

  it("retries a response whose body stalls, and reports a 200 that isn't JSON", async () => {
    const { createServer } = await import("node:http");
    let calls = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (calls++ === 0) {
          res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
          res.write('{"text": "par'); // then nothing: the body never finishes
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: "ok" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const one = synth([{ pause: 0.3 }, { speech: 1 }, { pause: 0.3 }]);
      const result = await transcribeTimed(one, { apiKey: "k", baseUrl: `http://127.0.0.1:${port}/v1`, timeoutMs: 200 });
      expect(result.segments.map((s) => s.text)).toEqual(["ok"]);
      expect(calls).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }

    api = await startFakeApi(() => ({ body: "<html>gateway</html>" }));
    const error = await transcribeTimed(clip(), { apiKey: "k", baseUrl: api.baseUrl, concurrency: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranscribeError);
    expect((error as Error).message).toBe("segment 0: response isn't JSON: <html>gateway</html>");
  });

  it("rejects a concurrency that would start no workers", async () => {
    await expect(transcribeTimed(clip(), { apiKey: "k", concurrency: Number.NaN })).rejects.toThrow(RangeError);
    await expect(transcribeTimed(clip(), { apiKey: "k", concurrency: 0 })).rejects.toThrow(RangeError);
  });

  it("retries a network error from fetch", async () => {
    let calls = 0;
    const flaky: typeof fetch = async (url, init) => {
      if (calls++ === 0) throw new TypeError("fetch failed");
      return fetch(url, init);
    };
    api = await startFakeApi(() => ({ body: { text: "ok" } }));
    const result = await transcribeTimed(clip(), { apiKey: "k", baseUrl: api.baseUrl, fetch: flaky, concurrency: 1 });
    expect(result.segments).toHaveLength(3);
  });

  it("times out a hung request and stops on the caller's abort", async () => {
    api = await startFakeApi(() => new Promise(() => {}));
    const timedOut = await transcribeTimed(clip(), { apiKey: "k", baseUrl: api.baseUrl, timeoutMs: 50, maxRetries: 0 }).catch((e: unknown) => e);
    expect((timedOut as Error).message).toMatch(/segment \d: request failed/);

    const controller = new AbortController();
    const pending = transcribeTimed(clip(), { apiKey: "k", baseUrl: api.baseUrl, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("user cancelled")), 30);
    await expect(pending).rejects.toThrow("user cancelled");
  });

  it("needs a key, and sends nothing for silence", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(transcribeTimed(clip())).rejects.toThrow("no API key");
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
    api = await startFakeApi(() => ({ body: { text: "should not be called" } }));
    const result = await transcribeTimed(synth([{ pause: 2 }]), { apiKey: "k", baseUrl: api.baseUrl });
    expect(result).toEqual({ text: "", duration: 2, segments: [], languages: [] });
    expect(api.requests).toHaveLength(0);
  });
});
