import { describe, expect, it } from "vitest";
import { detectSpeech } from "../src/vad.ts";
import { synth } from "./signal.ts";

describe("detectSpeech", () => {
  // Edges land 10 ms early at the start and 20 ms late at the end: the 3-frame energy smoothing and the band-pass
  // filter's ring. That bias is the same everywhere, and the request padding covers it.
  it("finds each burst between pauses, within 20 ms", () => {
    const pcm = synth([{ pause: 0.5 }, { speech: 1.2 }, { pause: 0.6 }, { speech: 2 }, { pause: 1 }, { speech: 0.8 }, { pause: 0.4 }]);
    const segments = detectSpeech(pcm);
    expect(segments.map((s) => [s.start, s.end])).toEqual([[0.49, 1.72], [2.29, 4.32], [5.29, 6.12]]);
  });

  it("keeps a pause shorter than minSilenceMs inside one segment", () => {
    const pcm = synth([{ pause: 0.3 }, { speech: 1 }, { pause: 0.2 }, { speech: 1 }, { pause: 0.3 }]);
    expect(detectSpeech(pcm).map((s) => [s.start, s.end])).toEqual([[0.29, 2.52]]);
    expect(detectSpeech(pcm, { minSilenceMs: 150 })).toHaveLength(2);
  });

  it("drops a click shorter than minSpeechMs", () => {
    const pcm = synth([{ pause: 1 }, { speech: 0.05 }, { pause: 1 }, { speech: 1 }, { pause: 0.5 }]);
    expect(detectSpeech(pcm).map((s) => [s.start, s.end])).toEqual([[2.04, 3.07]]);
  });

  it("returns nothing for digital silence or an empty signal", () => {
    expect(detectSpeech(synth([{ pause: 3 }]))).toEqual([]);
    expect(detectSpeech({ samples: new Float32Array(0), sampleRate: 16_000 })).toEqual([]);
  });

  it("pads the request window, but never past half the gap or the file edges", () => {
    const pcm = synth([{ pause: 0.1 }, { speech: 1 }, { pause: 0.42 }, { speech: 1 }, { pause: 0.05 }]);
    const [a, b] = detectSpeech(pcm, { padMs: 300 });
    expect(a).toEqual({ start: 0.09, end: 1.12, audioStart: 0, audioEnd: 1.315 });
    expect(b).toEqual({ start: 1.51, end: 2.54, audioStart: 1.315, audioEnd: 2.57 });
  });

  it("cuts a long segment at its quietest point, inside the limit", () => {
    // 9 s + a 0.2 s dip (shorter than minSilence, so no natural split) + 9 s: one 18.2 s run.
    const pcm = synth([{ pause: 0.5 }, { speech: 9 }, { pause: 0.2 }, { speech: 9 }, { pause: 0.5 }]);
    const segments = detectSpeech(pcm, { maxSegmentSec: 15 });
    expect(segments).toHaveLength(2);
    expect(segments[0]?.end).toBeGreaterThanOrEqual(9.5);
    expect(segments[0]?.end).toBeLessThanOrEqual(9.7);
    for (const s of segments) expect(s.end - s.start).toBeLessThanOrEqual(15);
    expect(segments[0]?.end).toBe(segments[1]?.start);
  });

  it("splits continuous speech with no dip into pieces no longer than the limit", () => {
    const segments = detectSpeech(synth([{ speech: 40 }]), { maxSegmentSec: 10 });
    expect(segments.length).toBeGreaterThanOrEqual(4);
    for (const s of segments) {
      expect(s.end - s.start).toBeLessThanOrEqual(10);
      expect(s.end - s.start).toBeGreaterThanOrEqual(2.5);
    }
    // Pieces are contiguous: the cuts lose no audio.
    for (let i = 1; i < segments.length; i++) expect(segments[i]?.start).toBe(segments[i - 1]?.end);
  });

  it("holds boundaries within 30 ms at 20 dB SNR white noise", () => {
    const truth = [[0.8, 2.8], [3.5, 4.7], [5.6, 7.1]];
    const pcm = synth([{ pause: 0.8 }, { speech: 2 }, { pause: 0.7 }, { speech: 1.2 }, { pause: 0.9 }, { speech: 1.5 }, { pause: 0.6 }], { snrDb: 20 });
    const found = detectSpeech(pcm);
    expect(found).toHaveLength(3);
    found.forEach((s, i) => {
      expect(Math.abs(s.start - (truth[i]?.[0] ?? 0))).toBeLessThanOrEqual(0.03);
      expect(Math.abs(s.end - (truth[i]?.[1] ?? 0))).toBeLessThanOrEqual(0.03);
    });
  });

  it("ignores mains hum below the speech band", () => {
    const pcm = synth([{ pause: 0.5 }, { speech: 1 }, { pause: 0.8 }, { speech: 1 }, { pause: 0.5 }]);
    // A 50 Hz hum about 13 dB louder than the speech, all the way through.
    for (let i = 0; i < pcm.samples.length; i++) pcm.samples[i] = (pcm.samples[i] ?? 0) + 0.6 * Math.sin((2 * Math.PI * 50 * i) / pcm.sampleRate);
    expect(detectSpeech(pcm).map((s) => [s.start, s.end])).toEqual([[0.49, 1.51], [2.29, 3.31]]);
    expect(detectSpeech(pcm, { band: false }).length).toBeLessThan(2);
  });

  it("keeps times right at 22.05 and 11.025 kHz, where a 10 ms frame isn't a whole number of samples", () => {
    for (const sampleRate of [22_050, 11_025, 44_100]) {
      const [s] = detectSpeech(synth([{ pause: 600 }, { speech: 1 }, { pause: 1 }], { sampleRate }));
      expect(Math.abs((s?.start ?? 0) - 600)).toBeLessThanOrEqual(0.03);
      expect(Math.abs((s?.end ?? 0) - 601)).toBeLessThanOrEqual(0.03);
      expect(s?.audioEnd).toBeLessThanOrEqual(602);
    }
  });

  it("rejects a segment limit that would cut speech into slivers", () => {
    const pcm = synth([{ speech: 0.5 }]);
    expect(() => detectSpeech(pcm, { maxSegmentSec: 0 })).toThrow(RangeError);
    expect(() => detectSpeech(pcm, { maxSegmentSec: 0.001 })).toThrow("maxSegmentSec must be at least 1 s");
    expect(() => detectSpeech(pcm, { frameMs: 0 })).toThrow(RangeError);
  });

  // Same signal and expected numbers as python/test_timed_transcript.py: the two implementations agree exactly.
  it("matches the Python twin on the shared parity fixture", () => {
    const pcm = synth([{ pause: 0.42 }, { speech: 1.37 }, { pause: 0.51 }, { speech: 0.9 }, { pause: 0.33 }, { speech: 2.2 }, { pause: 0.7 }], { snrDb: 15 });
    expect(detectSpeech(pcm)).toMatchInlineSnapshot(`
      [
        {
          "audioEnd": 2,
          "audioStart": 0.21,
          "end": 1.8,
          "start": 0.41,
        },
        {
          "audioEnd": 5.92,
          "audioStart": 2.09,
          "end": 5.72,
          "start": 2.29,
        },
      ]
    `);
  });
});
