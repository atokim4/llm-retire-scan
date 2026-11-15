import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isWav, readWav, type Pcm } from "./pcm.ts";

export class DecodeError extends Error {
  readonly code: "needs_ffmpeg" | "ffmpeg_failed" | "bad_wav";
  constructor(message: string, code: DecodeError["code"], options?: ErrorOptions) {
    super(message, options);
    this.name = "DecodeError";
    this.code = code;
  }
}

export interface DecodeOptions {
  /** Used for anything that isn't a plain PCM/float WAV (mp3, m4a, ogg, webm...). Default "ffmpeg" on PATH. */
  ffmpegPath?: string;
  /** Sample rate ffmpeg resamples to. WAV input keeps its own rate. Default 16000. */
  sampleRate?: number;
}

/** A path, or the bytes of an audio file, to mono float samples. */
export async function decodeAudio(input: string | Uint8Array, options: DecodeOptions = {}): Promise<Pcm> {
  const bytes = typeof input === "string" ? await readFile(input) : input;
  if (isWav(bytes)) {
    try {
      return readWav(bytes);
    } catch (error) {
      // Compressed audio in a WAV wrapper (ADPCM, mu-law...): let ffmpeg try.
      if (!(error instanceof Error && error.message.startsWith("unsupported WAV"))) {
        throw new DecodeError(`can't read WAV: ${(error as Error).message}`, "bad_wav", { cause: error });
      }
    }
  }
  return ffmpegDecode(bytes, options.ffmpegPath ?? "ffmpeg", options.sampleRate ?? 16_000);
}

function ffmpegDecode(bytes: Uint8Array, ffmpeg: string, sampleRate: number): Promise<Pcm> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    // ffmpeg may stop reading early on bad input; that EPIPE is reported through the exit code instead.
    child.stdin.on("error", () => {});
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT"
        ? new DecodeError(`this isn't a PCM WAV and ffmpeg wasn't found (${ffmpeg}); install ffmpeg or pass a WAV`,
          "needs_ffmpeg", { cause: error })
        : new DecodeError(`ffmpeg didn't start: ${error.message}`, "ffmpeg_failed", { cause: error }));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new DecodeError(`ffmpeg exited with ${code}: ${err.trim().slice(0, 300)}`, "ffmpeg_failed"));
        return;
      }
      const raw = Buffer.concat(out);
      const samples = new Float32Array(Math.floor(raw.length / 2));
      for (let i = 0; i < samples.length; i++) samples[i] = raw.readInt16LE(i * 2) / 32768;
      resolve({ samples, sampleRate });
    });
    child.stdin.end(bytes);
  });
}
