/** Mono audio as float samples in [-1, 1]. */
export interface Pcm {
  samples: Float32Array;
  sampleRate: number;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export function isWav(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE";
}

/**
 * Reads a RIFF/WAVE file: integer PCM (8, 16, 24, 32 bit) or 32-bit float, any channel count (averaged to mono).
 * Throws on anything else; decode other containers with ffmpeg first (see decode.ts).
 */
export function readWav(bytes: Uint8Array): Pcm {
  if (!isWav(bytes)) throw new Error("not a RIFF/WAVE file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: { tag: number; channels: number; sampleRate: number; bits: number } | undefined;
  let data: { offset: number; size: number } | undefined;

  for (let pos = 12; pos + 8 <= bytes.length; ) {
    const id = ascii(bytes, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      if (size < 16) throw new Error("WAV fmt chunk is too short");
      let tag = view.getUint16(body, true);
      if (tag === WAVE_FORMAT_EXTENSIBLE && size >= 40) tag = view.getUint16(body + 24, true);
      format = {
        tag,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      // Streamed WAVs write 0 or 0xFFFFFFFF as the size; take what is there.
      data = { offset: body, size: Math.min(size === 0 ? Infinity : size, bytes.length - body) };
      break;
    }
    pos = body + size + (size % 2);
  }
  if (!format) throw new Error("WAV has no fmt chunk");
  if (!data) throw new Error("WAV has no data chunk");
  const { tag, channels, sampleRate, bits } = format;
  if (channels < 1 || sampleRate < 1) throw new Error("WAV fmt chunk has no channels or sample rate");
  const read = sampleReader(view, tag, bits);
  const step = bits / 8;
  const frames = Math.floor(data.size / (step * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(data.offset + (i * channels + c) * step);
    samples[i] = sum / channels;
  }
  return { samples, sampleRate };
}

function sampleReader(view: DataView, tag: number, bits: number): (offset: number) => number {
  if (tag === WAVE_FORMAT_IEEE_FLOAT && bits === 32) return (o) => view.getFloat32(o, true);
  if (tag !== WAVE_FORMAT_PCM) throw new Error(`unsupported WAV encoding (format tag ${tag}, ${bits} bit)`);
  switch (bits) {
    case 8:
      return (o) => (view.getUint8(o) - 128) / 128;
    case 16:
      return (o) => view.getInt16(o, true) / 32768;
    case 24:
      return (o) => ((view.getUint8(o + 2) << 24) | (view.getUint8(o + 1) << 16) | (view.getUint8(o) << 8)) / 2147483648;
    case 32:
      return (o) => view.getInt32(o, true) / 2147483648;
    default:
      throw new Error(`unsupported WAV sample size: ${bits} bit`);
  }
}

/** 16-bit mono WAV of samples[from, to). */
export function encodeWav16(pcm: Pcm, from = 0, to = pcm.samples.length): Buffer<ArrayBuffer> {
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(pcm.samples.length, Math.ceil(to));
  const count = Math.max(0, end - start);
  const out = Buffer.alloc(44 + count * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + count * 2, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(WAVE_FORMAT_PCM, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(pcm.sampleRate, 24);
  out.writeUInt32LE(pcm.sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    const s = Math.max(-1, Math.min(1, pcm.samples[start + i] ?? 0));
    out.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), 44 + i * 2);
  }
  return out;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}
