import type { Pcm } from "./pcm.ts";

export interface VadOptions {
  /** Analysis frame. Default 10 ms. */
  frameMs?: number;
  /** Pauses shorter than this stay inside one segment. Default 350 ms. */
  minSilenceMs?: number;
  /** Speech runs shorter than this (clicks, breaths) are dropped. Default 150 ms. */
  minSpeechMs?: number;
  /** Audio kept around each segment in the request (never past half the gap to a neighbour). Default 200 ms. */
  padMs?: number;
  /** Longer segments are cut at their quietest 50 ms. Default 15 s; subtitles read better short. */
  maxSegmentSec?: number;
  /** Band-pass (Hz) applied before measuring energy; `false` measures the raw signal. Default [250, 3500]. */
  band?: [number, number] | false;
}

export interface VadSegment {
  /** Speech start and end, seconds from the start of the file. These become the timestamps. */
  start: number;
  end: number;
  /** The window sent to the API: the segment plus padding. */
  audioStart: number;
  audioEnd: number;
}

const DEFAULTS = { frameMs: 10, minSilenceMs: 350, minSpeechMs: 150, padMs: 200, maxSegmentSec: 15, band: [250, 3500] } as const;
const SILENT_DB = -100;
/** Neighbour frames averaged into each frame's energy, each side. */
const SMOOTH = 1;
/** dB above the noise floor a frame needs to count as speech. */
const ABOVE_FLOOR_DB = 3;
/** ...but never more than this far below the loud frames, so breaths in a clean recording stay pauses. */
const BELOW_PEAK_DB = 36;

/**
 * Frame energies in dBFS: mean square of each frame, averaged with its neighbours (`smooth` frames each side) so
 * that steady noise doesn't flicker across a threshold.
 */
export function frameEnergies(pcm: Pcm, frameMs: number = DEFAULTS.frameMs,
  band: readonly [number, number] | false = DEFAULTS.band): Float64Array {
  const size = frameSize(pcm.sampleRate, frameMs);
  const count = Math.floor(pcm.samples.length / size);
  const signal = band ? bandPass(pcm, band[0], band[1]) : pcm.samples;
  const power = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    let sum = 0;
    for (let i = f * size; i < (f + 1) * size; i++) {
      const s = signal[i] ?? 0;
      sum += s * s;
    }
    power[f] = sum / size;
  }
  const db = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, f - SMOOTH); k <= Math.min(count - 1, f + SMOOTH); k++, n++) sum += power[k] ?? 0;
    db[f] = sum > 0 ? Math.max(SILENT_DB, 10 * Math.log10(sum / n)) : SILENT_DB;
  }
  return db;
}

/** Samples per frame, rounded; at 22.05 kHz a 10 ms frame is 221 samples, so times come from this, not frameMs. */
export function frameSize(sampleRate: number, frameMs: number): number {
  return Math.max(1, Math.round((sampleRate * frameMs) / 1000));
}

/**
 * The signal through a 2nd-order Butterworth high-pass and low-pass (RBJ cookbook biquads, Q = 1/sqrt 2), keeping
 * the band most speech energy sits in. Hum, rumble and hiss outside it stop counting as speech.
 */
export function bandPass(pcm: Pcm, low: number, high: number): Float64Array {
  const out = Float64Array.from(pcm.samples);
  if (low > 0 && low < pcm.sampleRate / 2) biquad(out, pcm.sampleRate, low, "highpass");
  if (high > 0 && high < pcm.sampleRate / 2) biquad(out, pcm.sampleRate, high, "lowpass");
  return out;
}

function biquad(x: Float64Array, rate: number, cutoff: number, kind: "highpass" | "lowpass"): void {
  const w = (2 * Math.PI * cutoff) / rate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b1 = (kind === "lowpass" ? 1 - cos : -(1 + cos)) / a0;
  const b0 = (kind === "lowpass" ? (1 - cos) / 2 : (1 + cos) / 2) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i] ?? 0;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    x[i] = y0;
  }
}

/**
 * The speech threshold, from the file itself: the noise floor (10th-percentile frame) plus 3 dB, but no lower than
 * 36 dB under the speech level. The speech level is the 95th percentile of the frames above that floor margin, so a
 * file that is mostly silence (one sentence in half an hour) still has one.
 */
export function threshold(db: Float64Array): { floor: number; peak: number; threshold: number } {
  const sorted = Float64Array.from(db).sort();
  const pick = (values: Float64Array, p: number) => values[Math.floor(p * (values.length - 1))] ?? SILENT_DB;
  const floor = pick(sorted, 0.1);
  const first = sorted.findIndex((x) => x >= floor + ABOVE_FLOOR_DB);
  const peak = first < 0 ? floor : pick(sorted.subarray(first), 0.95);
  return { floor, peak, threshold: Math.max(floor + ABOVE_FLOOR_DB, peak - BELOW_PEAK_DB) };
}

/** Speech segments of a mono signal, by frame energy. Deterministic; the Python twin returns the same numbers. */
export function detectSpeech(pcm: Pcm, options: VadOptions = {}): VadSegment[] {
  const o = { ...DEFAULTS, ...definedOnly(options) };
  if (!(o.frameMs > 0)) throw new RangeError("frameMs must be a positive number");
  if (!(o.maxSegmentSec >= MIN_SEGMENT_LIMIT_SEC)) {
    throw new RangeError(`maxSegmentSec must be at least ${MIN_SEGMENT_LIMIT_SEC} s`);
  }
  const db = frameEnergies(pcm, o.frameMs, o.band);
  if (db.length === 0) return [];
  const { threshold: level, peak } = threshold(db);
  if (peak <= SILENT_DB + 1) return [];

  // 1. Runs of frames at or above the threshold.
  let runs: [number, number][] = [];
  for (let f = 0; f < db.length; ) {
    if ((db[f] ?? SILENT_DB) < level) { f++; continue; }
    const from = f;
    while (f < db.length && (db[f] ?? SILENT_DB) >= level) f++;
    runs.push([from, f]);
  }
  // 2. Close short pauses, then 3. drop what is still too short to be speech.
  const minGap = Math.round(o.minSilenceMs / o.frameMs);
  const merged: [number, number][] = [];
  for (const run of runs) {
    const last = merged.at(-1);
    if (last && run[0] - last[1] < minGap) last[1] = run[1];
    else merged.push([run[0], run[1]]);
  }
  const minRun = Math.round(o.minSpeechMs / o.frameMs);
  runs = merged.filter(([a, b]) => b - a >= minRun);
  // 4. Cut long segments at their quietest point.
  const maxFrames = Math.round((o.maxSegmentSec * 1000) / o.frameMs);
  const cut: [number, number][] = [];
  for (const run of runs) splitLong(db, run, maxFrames, cut);

  const frameSec = frameSize(pcm.sampleRate, o.frameMs) / pcm.sampleRate;
  const total = pcm.samples.length / pcm.sampleRate;
  const pad = o.padMs / 1000;
  return cut.map(([a, b], i) => {
    const start = a * frameSec;
    const end = b * frameSec;
    const prevEnd = i > 0 ? (cut[i - 1]?.[1] ?? 0) * frameSec : 0;
    const nextStart = i < cut.length - 1 ? (cut[i + 1]?.[0] ?? b) * frameSec : total;
    return {
      start: round3(start),
      end: round3(end),
      audioStart: round3(Math.max(start - pad, i > 0 ? (prevEnd + start) / 2 : 0)),
      audioEnd: round3(Math.min(end + pad, i < cut.length - 1 ? (end + nextStart) / 2 : total)),
    };
  });
}

const QUIET_WINDOW = 5;
/** Shorter limits would turn one phrase into a request per word. */
const MIN_SEGMENT_LIMIT_SEC = 1;

/**
 * Left to right: while a run is over the limit, cut at the quietest 50 ms between half the limit and the limit
 * (and at least a quarter of the limit before the run's end, so no sliver is left over).
 */
function splitLong(db: Float64Array, [a, b]: [number, number], maxFrames: number, out: [number, number][]): void {
  let from = a;
  while (b - from > maxFrames) {
    const first = from + Math.floor(maxFrames / 2);
    const last = Math.min(from + maxFrames, b - Math.floor(maxFrames / 4)) - QUIET_WINDOW;
    let best = first;
    let bestEnergy = Infinity;
    for (let f = first; f <= last; f++) {
      let sum = 0;
      for (let k = 0; k < QUIET_WINDOW; k++) sum += db[f + k] ?? 0;
      if (sum < bestEnergy) {
        bestEnergy = sum;
        best = f;
      }
    }
    const at = best + Math.floor(QUIET_WINDOW / 2);
    out.push([from, at]);
    from = at;
  }
  out.push([from, b]);
}

function round3(x: number): number {
  // floor(x + 0.5), not banker's rounding, so Python gives the same numbers.
  return Math.floor(x * 1000 + 0.5) / 1000;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
