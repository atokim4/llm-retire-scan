import type { Pcm } from "../src/pcm.ts";

export type Part = { speech: number } | { pause: number };

/**
 * A speech-like test signal: voiced bursts (a 180 Hz tone with harmonics, syllable-rate amplitude wobble) and
 * pauses, plus optional white noise at a given SNR. Deterministic (fixed-seed LCG), so tests can assert exact values.
 */
export function synth(parts: Part[], options: { sampleRate?: number; snrDb?: number; level?: number } = {}): Pcm {
  const rate = options.sampleRate ?? 16_000;
  const level = options.level ?? 0.3;
  const total = parts.reduce((t, p) => t + ("speech" in p ? p.speech : p.pause), 0);
  const samples = new Float32Array(Math.round(total * rate));
  let i = 0;
  for (const part of parts) {
    const n = Math.round(("speech" in part ? part.speech : part.pause) * rate);
    if ("speech" in part) {
      for (let k = 0; k < n; k++) {
        const t = k / rate;
        const wobble = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t);
        const tone = Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t) + 0.25 * Math.sin(2 * Math.PI * 540 * t);
        samples[i + k] = (level / 1.75) * wobble * tone;
      }
    }
    i += n;
  }
  if (options.snrDb !== undefined) addNoise(samples, level, options.snrDb);
  return { samples, sampleRate: rate };
}

function addNoise(samples: Float32Array, level: number, snrDb: number): void {
  // Signal RMS of the burst is about level * 0.45; noise RMS set relative to that.
  const noiseRms = (level * 0.45) / 10 ** (snrDb / 20);
  let seed = 12345;
  const uniform = () => {
    // MINSTD: products stay below 2^53, so JavaScript numbers and Python ints give the same sequence.
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647 - 0.5;
  };
  const scale = noiseRms * Math.sqrt(12);
  for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] ?? 0) + scale * uniform();
}
