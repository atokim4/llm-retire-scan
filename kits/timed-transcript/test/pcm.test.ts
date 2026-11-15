import { describe, expect, it } from "vitest";
import { encodeWav16, readWav } from "../src/pcm.ts";
import { decodeAudio, DecodeError } from "../src/decode.ts";

/** A WAV with an arbitrary encoding, plus extra chunks before data. */
function wav(opts: { tag: number; channels: number; rate: number; bits: number; data: Buffer; extensible?: boolean; listChunk?: boolean }): Buffer {
  const fmt = Buffer.alloc(opts.extensible ? 40 : 16);
  fmt.writeUInt16LE(opts.extensible ? 0xfffe : opts.tag, 0);
  fmt.writeUInt16LE(opts.channels, 2);
  fmt.writeUInt32LE(opts.rate, 4);
  fmt.writeUInt32LE((opts.rate * opts.channels * opts.bits) / 8, 8);
  fmt.writeUInt16LE((opts.channels * opts.bits) / 8, 12);
  fmt.writeUInt16LE(opts.bits, 14);
  if (opts.extensible) {
    fmt.writeUInt16LE(22, 16);
    fmt.writeUInt16LE(opts.tag, 24);
  }
  const chunk = (id: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, "ascii");
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const body = Buffer.concat([
    Buffer.from("WAVE"), chunk("fmt ", fmt),
    ...(opts.listChunk ? [chunk("LIST", Buffer.from("odd"))] : []),
    chunk("data", opts.data),
  ]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

describe("readWav", () => {
  it("averages 16-bit stereo to mono and skips an odd-sized chunk before data", () => {
    const data = Buffer.alloc(8);
    data.writeInt16LE(16384, 0); data.writeInt16LE(0, 2);
    data.writeInt16LE(-32768, 4); data.writeInt16LE(-32768, 6);
    const pcm = readWav(wav({ tag: 1, channels: 2, rate: 8000, bits: 16, data, listChunk: true }));
    expect(pcm.sampleRate).toBe(8000);
    expect(Array.from(pcm.samples)).toEqual([0.25, -1]);
  });

  it("reads 8-bit, 24-bit, 32-bit int and 32-bit float, also as WAVE_FORMAT_EXTENSIBLE", () => {
    expect(Array.from(readWav(wav({ tag: 1, channels: 1, rate: 8000, bits: 8, data: Buffer.from([128, 192]) })).samples)).toEqual([0, 0.5]);
    const d24 = Buffer.from([0x00, 0x00, 0x40, 0x00, 0x00, 0xc0]);
    expect(Array.from(readWav(wav({ tag: 1, channels: 1, rate: 8000, bits: 24, data: d24, extensible: true })).samples)).toEqual([0.5, -0.5]);
    const d32 = Buffer.alloc(4); d32.writeInt32LE(-1073741824, 0);
    expect(Array.from(readWav(wav({ tag: 1, channels: 1, rate: 8000, bits: 32, data: d32 })).samples)).toEqual([-0.5]);
    const f32 = Buffer.alloc(4); f32.writeFloatLE(0.125, 0);
    expect(Array.from(readWav(wav({ tag: 3, channels: 1, rate: 8000, bits: 32, data: f32 })).samples)).toEqual([0.125]);
  });

  it("rejects what it can't read", () => {
    expect(() => readWav(Buffer.from("ID3 not a wav at all"))).toThrow("not a RIFF/WAVE file");
    expect(() => readWav(wav({ tag: 2, channels: 1, rate: 8000, bits: 4, data: Buffer.alloc(4) }))).toThrow("unsupported WAV encoding");
  });

  it("round-trips through encodeWav16, slicing by sample index", () => {
    const samples = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const back = readWav(encodeWav16({ samples, sampleRate: 16_000 }, 1, 4));
    expect(back.sampleRate).toBe(16_000);
    expect(Array.from(back.samples).map((x) => Math.round(x * 1000) / 1000)).toEqual([0.5, -0.5, 1]);
  });
});

describe("decodeAudio", () => {
  it("says ffmpeg is needed for a non-WAV file when it isn't installed", async () => {
    const error = await decodeAudio(Buffer.from("ID3\u0004 fake mp3"), { ffmpegPath: "/nonexistent/ffmpeg" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecodeError);
    expect((error as DecodeError).code).toBe("needs_ffmpeg");
  });

  it("reports a broken WAV instead of sending it to ffmpeg", async () => {
    const error = await decodeAudio(Buffer.from("RIFF\u0004\u0000\u0000\u0000WAVE"), { ffmpegPath: "/nonexistent/ffmpeg" }).catch((e: unknown) => e);
    expect((error as DecodeError).code).toBe("bad_wav");
  });

  // Runs when FFMPEG points at an ffmpeg binary: a WAV made by ffmpeg's own sine source, read back through the pipe.
  it.skipIf(!process.env.FFMPEG)("decodes through ffmpeg to 16 kHz mono", async () => {
    const { execFileSync } = await import("node:child_process");
    const flac = execFileSync(process.env.FFMPEG as string, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "sine=frequency=440:duration=1.5:sample_rate=44100", "-c:a", "flac", "-f", "flac", "pipe:1"]);
    const pcm = await decodeAudio(flac, { ffmpegPath: process.env.FFMPEG as string });
    expect(pcm.sampleRate).toBe(16_000);
    expect(pcm.samples.length).toBeGreaterThan(23_900);
    expect(pcm.samples.length).toBeLessThan(24_100);
  });
});
