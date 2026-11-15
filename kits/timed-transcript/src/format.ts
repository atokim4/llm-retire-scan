import type { TimedTranscript } from "./transcribe.ts";

/** HH:MM:SS,mmm (SRT) or HH:MM:SS.mmm (WebVTT). */
export function timecode(seconds: number, separator: "," | "."): string {
  const ms = Math.max(0, Math.floor(seconds * 1000 + 0.5));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${String(ms % 1000).padStart(3, "0")}`;
}

export function toSrt(transcript: TimedTranscript): string {
  return transcript.segments
    .map((s, i) => `${i + 1}\n${timecode(s.start, ",")} --> ${timecode(s.end, ",")}\n${cueText(s.text)}\n`)
    .join("\n");
}

export function toVtt(transcript: TimedTranscript): string {
  const cues = transcript.segments.map((s) =>
    `${timecode(s.start, ".")} --> ${timecode(s.end, ".")}\n${vttEscape(cueText(s.text))}\n`);
  return ["WEBVTT\n", ...cues].join("\n");
}

/**
 * The fields of whisper-1's `verbose_json` this kit can fill honestly. Per-segment `tokens`, `avg_logprob`,
 * `compression_ratio`, `no_speech_prob` and `words` are left out; there is nothing to fill them with.
 */
export function toVerboseJson(transcript: TimedTranscript) {
  return {
    task: "transcribe" as const,
    language: transcript.languages[0] ?? "",
    duration: transcript.duration,
    text: transcript.text,
    segments: transcript.segments.map(({ id, start, end, text }) => ({ id, start, end, text })),
  };
}

function cueText(text: string): string {
  // A blank line ends a cue in both formats.
  return text.replace(/\r\n?/g, "\n").replace(/\n{2,}/g, "\n").trim();
}

/** In WebVTT cue text `&` starts an entity and `<` a tag; escaping `>` also covers a stray `-->`. */
function vttEscape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
