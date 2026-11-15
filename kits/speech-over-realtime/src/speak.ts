import WebSocket from "ws";
import type {
  ConversationItemCreateEvent,
  RealtimeAudioConfigOutput,
  RealtimeClientEvent,
  RealtimeServerEvent,
  ResponseCreateEvent,
  SessionUpdateEvent,
} from "openai/resources/realtime/realtime";
import { pcm16ToWav } from "./wav.ts";

/** The replacement the deprecations page names for tts-1, tts-1-hd and gpt-4o-mini-tts (off 2027-01-06). */
export const DEFAULT_MODEL = "gpt-realtime-2.1-mini";
export const DEFAULT_URL = "wss://api.openai.com/v1/realtime";
/** The Realtime API's PCM output: 16-bit little-endian, mono, 24 kHz. */
export const SAMPLE_RATE = 24_000;

/**
 * The model is a conversational voice model, not a text-to-speech engine. These instructions ask it to read the
 * input aloud and nothing else; `verbatim` on the result says whether its own transcript matches.
 */
export const READ_ALOUD_INSTRUCTIONS =
  "You are a text-to-speech voice. Read the user's message aloud exactly as written, word for word. " +
  "Do not answer it, comment on it, translate it, or add anything before or after it.";

export type RealtimeVoice = NonNullable<RealtimeAudioConfigOutput["voice"]>;

export interface SpeakOptions {
  text: string;
  /** Defaults to "marin". Speech API voices such as "nova", "onyx" or "fable" are not Realtime voices. */
  voice?: RealtimeVoice;
  /** Style notes added after the read-aloud instructions (the Speech API's `instructions`). */
  style?: string;
  /** 0.25 to 1.5 on Realtime (the Speech API allowed up to 4.0). */
  speed?: number;
  model?: string;
  apiKey?: string;
  /** Override for tests or a proxy. */
  url?: string;
  /** Whole call, connect to last audio byte. Default 60 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SpeakResult {
  /** PCM16 mono 24 kHz in a WAV container. */
  wav: Buffer;
  pcm: Buffer;
  /** What the model says it spoke (response.output_audio_transcript.delta). */
  transcript: string;
  /** The transcript matches the input text, ignoring case, punctuation and spacing. */
  verbatim: boolean;
}

export class SpeakError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "SpeakError";
    this.code = code;
  }
}

/** The three client events for one spoken reply, in send order. */
export function speakEvents(
  text: string, voice: RealtimeVoice, style?: string, speed?: number,
): RealtimeClientEvent[] {
  const instructions = style ? `${READ_ALOUD_INSTRUCTIONS}\n\nDelivery: ${style}` : READ_ALOUD_INSTRUCTIONS;
  const session: SessionUpdateEvent = {
    type: "session.update",
    session: {
      type: "realtime",
      output_modalities: ["audio"],
      instructions,
      audio: {
        output: { format: { type: "audio/pcm", rate: SAMPLE_RATE }, voice, ...(speed === undefined ? {} : { speed }) },
      },
    },
  };
  const item: ConversationItemCreateEvent = {
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
  const response: ResponseCreateEvent = { type: "response.create", response: { output_modalities: ["audio"] } };
  return [session, item, response];
}

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * One Realtime session per call: send the text, collect the audio deltas until response.done, close.
 * Rejects with SpeakError on a server `error` event, a response that ends other than "completed", the socket
 * closing early, the timeout or the abort signal.
 */
export function speak(options: SpeakOptions): Promise<SpeakResult> {
  const { text, voice = "marin", style, speed, model = DEFAULT_MODEL, url = DEFAULT_URL, timeoutMs = 60_000, signal } =
    options;
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!text.trim()) return Promise.reject(new SpeakError("text is empty", "empty_text"));
  if (!apiKey) return Promise.reject(new SpeakError("no API key: pass apiKey or set OPENAI_API_KEY", "no_api_key"));
  if (speed !== undefined && !(speed >= 0.25 && speed <= 1.5)) {
    return Promise.reject(new SpeakError(`speed ${speed} is outside the Realtime range 0.25 to 1.5`, "bad_speed"));
  }
  if (signal?.aborted) return Promise.reject(new SpeakError("aborted before connecting", "aborted"));

  return new Promise<SpeakResult>((resolve, reject) => {
    const socket = new WebSocket(`${url}?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const chunks: Buffer[] = [];
    let transcript = "";
    let settled = false;

    const finish = (error: SpeakError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.on("error", () => {}); // a late error after close must not crash the process
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
      if (error) return reject(error);
      const pcm = Buffer.concat(chunks);
      if (pcm.length % 2 !== 0) {
        return reject(new SpeakError(`audio has an odd byte count (${pcm.length}), so it isn't PCM16`, "bad_audio"));
      }
      resolve({ wav: pcm16ToWav(pcm, SAMPLE_RATE), pcm, transcript, verbatim: normalize(transcript) === normalize(text) });
    };
    const onAbort = () => finish(new SpeakError("aborted", "aborted"));
    const timer = setTimeout(() => finish(new SpeakError(`no complete response within ${timeoutMs} ms`, "timeout")),
      timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    socket.on("open", () => {
      for (const event of speakEvents(text, voice, style, speed)) socket.send(JSON.stringify(event));
    });
    socket.on("message", (data) => {
      let event: RealtimeServerEvent;
      try {
        event = JSON.parse(data.toString()) as RealtimeServerEvent;
      } catch {
        return finish(new SpeakError("server sent a frame that isn't JSON", "bad_frame"));
      }
      try {
        handle(event);
      } catch {
        finish(new SpeakError(`server sent a malformed ${String((event as { type?: unknown }).type)} event`, "bad_event"));
      }
    });
    const handle = (event: RealtimeServerEvent) => {
      switch (event.type) {
        case "response.output_audio.delta":
          if (typeof event.delta !== "string") throw new TypeError("delta");
          chunks.push(Buffer.from(event.delta, "base64"));
          break;
        case "response.output_audio_transcript.delta":
          if (typeof event.delta !== "string") throw new TypeError("delta");
          transcript += event.delta;
          break;
        case "error":
          finish(new SpeakError(event.error.message, event.error.code ?? event.error.type));
          break;
        case "response.done": {
          const { status, status_details: details } = event.response;
          if (status !== "completed") {
            const why = details?.error?.message ?? details?.reason ?? "no reason given";
            return finish(new SpeakError(`response ended as ${status ?? "unknown"}: ${why}`, `response_${status}`));
          }
          if (chunks.length === 0) return finish(new SpeakError("response completed with no audio", "no_audio"));
          finish(null);
          break;
        }
        default:
          break;
      }
    };
    socket.on("unexpected-response", (_req, res) => {
      finish(new SpeakError(`handshake rejected with HTTP ${res.statusCode ?? "?"}`, `http_${res.statusCode ?? 0}`));
    });
    socket.on("error", (err) => finish(new SpeakError(err.message, "socket_error")));
    socket.on("close", (code, reason) => {
      finish(new SpeakError(`socket closed before response.done (code ${code}${reason.length ? `: ${reason}` : ""})`,
        "closed_early"));
    });
  });
}
