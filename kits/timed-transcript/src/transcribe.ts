import { decodeAudio, type DecodeOptions } from "./decode.ts";
import { encodeWav16, type Pcm } from "./pcm.ts";
import { detectSpeech, type VadOptions, type VadSegment } from "./vad.ts";

/** The replacement the deprecations page names for whisper-1 (off 2027-02-26) on /v1/audio/transcriptions. */
export const DEFAULT_MODEL = "gpt-transcribe";
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface TimedSegment {
  id: number;
  /** Seconds from the start of the file: the speech bounds the local VAD found, not model timestamps. */
  start: number;
  end: number;
  text: string;
}

export interface TimedTranscript {
  text: string;
  /** Seconds. */
  duration: number;
  segments: TimedSegment[];
  /** Language codes gpt-transcribe reported across the segments, in first-seen order. */
  languages: string[];
}

export interface TranscribeOptions {
  apiKey?: string;
  model?: string;
  /** ISO-639-1 hints, sent as `languages[]` (gpt-transcribe replaces the singular `language`). */
  languages?: string[];
  /** Sent as `keywords[]`: names and terms the model should spell right. */
  keywords?: string[];
  /** Context about the recording, sent with every segment. */
  prompt?: string;
  baseUrl?: string;
  /** Requests in flight at once. Default 4. */
  concurrency?: number;
  /** Retries per segment on 408/409/429/5xx and network errors. Default 3. */
  maxRetries?: number;
  /** Per request. Default 60 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
  vad?: VadOptions;
  decode?: DecodeOptions;
  /** For tests or a proxy. */
  fetch?: typeof fetch;
}

export class TranscribeError extends Error {
  readonly status: number | undefined;
  readonly segment: number | undefined;
  constructor(message: string, status?: number, segment?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranscribeError";
    this.status = status;
    this.segment = segment;
  }
}

/**
 * What a whisper-1 `verbose_json` call gave you, on gpt-transcribe: finds the speech with a local energy VAD,
 * transcribes each segment as its own request, and returns the segments with their offsets. Accepts a path or
 * file bytes (WAV directly, anything else through ffmpeg) or decoded PCM.
 */
export async function transcribeTimed(input: string | Uint8Array | Pcm, options: TranscribeOptions = {}): Promise<TimedTranscript> {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("concurrency must be a whole number of at least 1");
  const pcm = isPcm(input) ? input : await decodeAudio(input, options.decode);
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new TranscribeError("no API key: pass apiKey or set OPENAI_API_KEY");
  const found = detectSpeech(pcm, options.vad);
  const texts = await mapLimited(found, concurrency, options.signal,
    (segment, index, signal) => transcribeSegment(pcm, segment, index, { ...options, apiKey, signal }));

  const languages: string[] = [];
  const segments: TimedSegment[] = [];
  found.forEach((segment, index) => {
    const result = texts[index];
    if (!result) return;
    for (const code of result.languages) if (!languages.includes(code)) languages.push(code);
    if (result.text) segments.push({ id: segments.length, start: segment.start, end: segment.end, text: result.text });
  });
  return {
    text: segments.map((s) => s.text).join(" "),
    duration: Math.floor((pcm.samples.length / pcm.sampleRate) * 1000 + 0.5) / 1000,
    segments,
    languages,
  };
}

interface SegmentText {
  text: string;
  languages: string[];
}

const RETRY_STATUS = new Set([408, 409, 429]);

async function transcribeSegment(pcm: Pcm, segment: VadSegment, index: number,
  options: TranscribeOptions & { apiKey: string; signal: AbortSignal }): Promise<SegmentText> {
  const doFetch = options.fetch ?? fetch;
  const url = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/audio/transcriptions`;
  const wav = encodeWav16(pcm, segment.audioStart * pcm.sampleRate, segment.audioEnd * pcm.sampleRate);
  const maxRetries = options.maxRetries ?? 3;

  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), `segment-${index}.wav`);
    form.append("model", options.model ?? DEFAULT_MODEL);
    form.append("response_format", "json");
    for (const code of options.languages ?? []) form.append("languages[]", code);
    for (const word of options.keywords ?? []) form.append("keywords[]", word);
    if (options.prompt) form.append("prompt", options.prompt);

    let response: Response;
    let body: string;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}` },
        body: form,
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 60_000)]),
      });
      // Inside the try: a stall or reset while the body streams in is retried like one before the headers.
      body = await response.text();
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason;
      if (attempt >= maxRetries) {
        throw new TranscribeError(`segment ${index}: request failed: ${(error as Error).message}`, undefined, index,
          { cause: error });
      }
      await sleep(backoffMs(attempt), options.signal);
      continue;
    }
    if (response.ok) return parseText(body, index);
    if ((RETRY_STATUS.has(response.status) || response.status >= 500) && attempt < maxRetries) {
      await sleep(retryAfterMs(response) ?? backoffMs(attempt), options.signal);
      continue;
    }
    throw new TranscribeError(`segment ${index}: HTTP ${response.status}: ${apiMessage(body)}`, response.status, index);
  }
}

function parseText(body: string, index: number): SegmentText {
  let parsed: { text?: unknown; languages?: { code?: unknown }[] };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new TranscribeError(`segment ${index}: response isn't JSON: ${body.slice(0, 200)}`, 200, index);
  }
  if (typeof parsed?.text !== "string") throw new TranscribeError(`segment ${index}: response has no text`, 200, index);
  const languages = (Array.isArray(parsed.languages) ? parsed.languages : [])
    .map((l) => l?.code).filter((c): c is string => typeof c === "string");
  return { text: parsed.text.trim(), languages };
}

function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt * (0.75 + Math.random() * 0.5);
}

/** Retry-After in seconds or as a date, capped at 30 s. */
function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), 30_000) : undefined;
}

function apiMessage(body: string): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === "string") return message;
  } catch {
    // not JSON
  }
  return body.slice(0, 300) || "(empty body)";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Runs `work` over items with at most `limit` in flight; the first failure aborts the rest. Keeps input order. */
async function mapLimited<T, R>(items: T[], limit: number, outer: AbortSignal | undefined,
  work: (item: T, index: number, signal: AbortSignal) => Promise<R>): Promise<R[]> {
  const controller = new AbortController();
  const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
  const results: R[] = new Array(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try {
        results[index] = await work(items[index] as T, index, signal);
      } catch (error) {
        if (!failure) {
          failure = { error: outer?.aborted ? outer.reason : error };
          controller.abort(failure.error);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
  return results;
}

function isPcm(input: unknown): input is Pcm {
  return typeof input === "object" && input !== null && "samples" in input && "sampleRate" in input;
}
