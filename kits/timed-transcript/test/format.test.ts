import { describe, expect, it } from "vitest";
import { timecode, toSrt, toVerboseJson, toVtt } from "../src/format.ts";
import type { TimedTranscript } from "../src/transcribe.ts";

const transcript: TimedTranscript = {
  text: "First line. Second --> line.",
  duration: 3725.5,
  languages: ["en"],
  segments: [
    { id: 0, start: 0.42, end: 1.79, text: "First line." },
    { id: 1, start: 3661.2345, end: 3663, text: "Second -->\n\n line." },
  ],
};

describe("formats", () => {
  it("rounds timecodes to the millisecond and rolls over hours", () => {
    expect(timecode(3661.2345, ",")).toBe("01:01:01,235");
    expect(timecode(59.9996, ".")).toBe("00:01:00.000");
    expect(timecode(-0.01, ",")).toBe("00:00:00,000");
  });

  it("writes SRT cues numbered from 1, with no blank line inside a cue", () => {
    expect(toSrt(transcript)).toBe(
      "1\n00:00:00,420 --> 00:00:01,790\nFirst line.\n\n2\n01:01:01,235 --> 01:01:03,000\nSecond -->\n line.\n");
  });

  it("writes WebVTT with the header, escaping &, < and > in cue text", () => {
    expect(toVtt(transcript)).toBe(
      "WEBVTT\n\n00:00:00.420 --> 00:00:01.790\nFirst line.\n\n01:01:01.235 --> 01:01:03.000\nSecond --&gt;\n line.\n");
    const tags = { ...transcript, segments: [{ id: 0, start: 0, end: 1, text: "I <3 R&D <b" }] };
    expect(toVtt(tags)).toContain("\nI &lt;3 R&amp;D &lt;b\n");
  });

  it("fills only the verbose_json fields it has", () => {
    expect(toVerboseJson(transcript)).toEqual({
      task: "transcribe", language: "en", duration: 3725.5, text: "First line. Second --> line.",
      segments: [
        { id: 0, start: 0.42, end: 1.79, text: "First line." },
        { id: 1, start: 3661.2345, end: 3663, text: "Second -->\n\n line." },
      ],
    });
  });
});
