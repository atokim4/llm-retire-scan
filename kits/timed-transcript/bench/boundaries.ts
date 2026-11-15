/**
 * How far the VAD's segment boundaries land from the pauses in a real recording, clean and with added noise.
 *
 *   node bench/boundaries.ts <clean.wav> <ffmpeg> [out-dir]
 *
 * Reference pauses come from a different tool on the clean file: ffmpeg's silencedetect (-45 dB, 0.35 s, the
 * kit's minSilenceMs). Noise is added here (fixed seed), at an SNR measured against the speech the reference marks.
 * If out-dir is given, each noisy signal is written there as a WAV, with the Node segments as JSON, so the Python
 * twin can be checked against the same files.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeWav16, readWav, type Pcm } from "../src/pcm.ts";
import { detectSpeech, type VadSegment } from "../src/vad.ts";

const [wavPath, ffmpeg, outDir] = process.argv.slice(2);
if (!wavPath || !ffmpeg) {
  console.error("usage: node bench/boundaries.ts <clean.wav> <ffmpeg> [out-dir]");
  process.exit(2);
}
const clean = readWav(readFileSync(wavPath));
const duration = clean.samples.length / clean.sampleRate;

const pauses = parsePauses(silenceLog(ffmpeg, wavPath));
const speech = complement(pauses, duration);

const speechRms = rms(clean, speech);
console.log(`file: ${duration.toFixed(1)} s, reference: ${speech.length} speech runs, ${pauses.length} pauses ` +
  `(${pauses.filter(([a, b]) => a > 0 && b < duration).length} between speech), speech RMS ${db(speechRms).toFixed(1)} dBFS`);
console.log("| noise | SNR dB | segments | pauses found | extra splits | forced cuts | pause-edge error ms (median / p90 / max) | speech sent |");
console.log("|---|---|---|---|---|---|---|---|");

for (const kind of ["none", "white", "pink"] as const) {
  for (const snr of kind === "none" ? [Infinity] : [20, 10, 5]) {
    const pcm = kind === "none" ? clean : withNoise(clean, kind, speechRms / 10 ** (snr / 20));
    const found = detectSpeech(pcm);
    const row = score(found, speech, pauses, duration);
    const line = `| ${kind} | ${snr === Infinity ? "clean" : snr} | ${found.length} | ${row.pausesFound}/${row.innerPauses} | ` +
      `${row.extraSplits} | ${row.forcedCuts} | ${row.median} / ${row.p90} / ${row.max} | ${row.covered}% |`;
    console.log(line);
    if (outDir) {
      const name = `${kind}-${snr === Infinity ? "clean" : snr}`;
      writeFileSync(join(outDir, `${name}.wav`), encodeWav16(pcm));
      writeFileSync(join(outDir, `${name}.json`), JSON.stringify(found));
    }
  }
}

/** silencedetect writes to stderr; spawnSync keeps it whatever the exit code. */
function silenceLog(bin: string, file: string): string {
  const run = spawnSync(bin, ["-hide_banner", "-nostats", "-i", file, "-af", "silencedetect=n=-45dB:d=0.35", "-f", "null", "-"],
    { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`ffmpeg silencedetect failed: ${run.stderr.slice(-300)}`);
  return run.stderr;
}

function parsePauses(text: string): [number, number][] {
  const out: [number, number][] = [];
  let start: number | undefined;
  for (const line of text.split("\n")) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (e && start !== undefined) {
      out.push([start, Number(e[1])]);
      start = undefined;
    }
  }
  if (start !== undefined) out.push([start, duration]);
  return out;
}

function complement(gaps: [number, number][], total: number): [number, number][] {
  const out: [number, number][] = [];
  let at = 0;
  for (const [a, b] of gaps) {
    if (a > at) out.push([at, a]);
    at = b;
  }
  if (at < total) out.push([at, total]);
  return out;
}

function rms(pcm: Pcm, spans: [number, number][]): number {
  let sum = 0;
  let n = 0;
  for (const [a, b] of spans) {
    for (let i = Math.floor(a * pcm.sampleRate); i < Math.min(pcm.samples.length, b * pcm.sampleRate); i++) {
      sum += (pcm.samples[i] ?? 0) ** 2;
      n++;
    }
  }
  return Math.sqrt(sum / Math.max(1, n));
}

function db(x: number): number {
  return 20 * Math.log10(x);
}

/** White, or pink (Paul Kellet's filter), scaled to `targetRms`. Fixed seed. */
function withNoise(pcm: Pcm, kind: "white" | "pink", targetRms: number): Pcm {
  let seed = 987654321;
  const uniform = () => (seed = (seed * 48271) % 2147483647) / 2147483647 - 0.5;
  const noise = new Float64Array(pcm.samples.length);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < noise.length; i++) {
    const w = uniform();
    if (kind === "white") {
      noise[i] = w;
      continue;
    }
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    noise[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  let sum = 0;
  for (const x of noise) sum += x * x;
  const scale = targetRms / Math.sqrt(sum / noise.length);
  const samples = new Float32Array(pcm.samples.length);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.max(-1, Math.min(1, (pcm.samples[i] ?? 0) + scale * (noise[i] ?? 0)));
  return { samples, sampleRate: pcm.sampleRate };
}

/**
 * pausesFound: reference pauses between speech that a detected gap overlaps. extraSplits: detected gaps that overlap
 * no reference pause, not counting cuts made by maxSegmentSec (forcedCuts, gap 0). Boundary error: for each found
 * pause, the detected gap's edges against the pause's edges (the first gap that overlaps it), plus the first start
 * and the last end. covered: share of reference speech time inside the audio windows sent to the API.
 */
function score(found: VadSegment[], ref: [number, number][], refPauses: [number, number][], total: number) {
  const inner = refPauses.filter(([a, b]) => a > 0 && b < total);
  const gaps: [number, number][] = [];
  let forcedCuts = 0;
  for (let i = 1; i < found.length; i++) {
    const a = found[i - 1]?.end ?? 0;
    const b = found[i]?.start ?? 0;
    if (b - a <= 0) forcedCuts++;
    else gaps.push([a, b]);
  }
  const overlaps = (x: [number, number], y: [number, number]) => x[0] < y[1] && y[0] < x[1];
  const errors: number[] = [];
  let pausesFound = 0;
  for (const p of inner) {
    const g = gaps.find((gap) => overlaps(gap, p));
    if (!g) continue;
    pausesFound++;
    errors.push(Math.abs(g[0] - p[0]), Math.abs(g[1] - p[1]));
  }
  if (found.length && ref.length) {
    errors.push(Math.abs((found[0]?.start ?? 0) - (ref[0]?.[0] ?? 0)), Math.abs((found.at(-1)?.end ?? 0) - (ref.at(-1)?.[1] ?? 0)));
  }
  const extraSplits = gaps.filter((g) => !inner.some((p) => overlaps(g, p))).length;
  let speechTime = 0;
  let coveredTime = 0;
  for (const [a, b] of ref) {
    speechTime += b - a;
    for (const s of found) coveredTime += Math.max(0, Math.min(b, s.audioEnd) - Math.max(a, s.audioStart));
  }
  errors.sort((x, y) => x - y);
  const ms = (q: number) => String(Math.round((errors[Math.min(errors.length - 1, Math.floor(q * errors.length))] ?? 0) * 1000));
  return { innerPauses: inner.length, pausesFound, extraSplits, forcedCuts, median: ms(0.5), p90: ms(0.9), max: ms(1),
    covered: ((100 * coveredTime) / Math.max(speechTime, 1e-9)).toFixed(1) };
}
