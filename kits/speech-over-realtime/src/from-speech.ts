import type { SpeechCreateParams } from "openai/resources/audio/speech";
import { SpeakError, type SpeakOptions } from "./speak.ts";

/** Speech API voices with no Realtime equivalent of the same name. */
export const SPEECH_ONLY_VOICES = new Set(["fable", "onyx", "nova"]);

export type SpeechParams = Pick<SpeechCreateParams, "input" | "voice" | "instructions" | "response_format" | "speed"> & {
  model?: string;
};

/**
 * Maps an `audio.speech.create` body to `speak()` options, and refuses what would silently change:
 * a voice Realtime doesn't have, an encoded format (mp3/opus/aac/flac: this kit returns WAV or raw PCM only),
 * a speed outside 0.25 to 1.5.
 */
export function fromSpeechParams(params: SpeechParams): SpeakOptions & { format: "wav" | "pcm" } {
  const problems: string[] = [];
  const voice = typeof params.voice === "string" ? params.voice : params.voice.id;
  if (SPEECH_ONLY_VOICES.has(voice)) {
    problems.push(`voice "${voice}" is a Speech API voice with no Realtime equivalent; pick one of alloy, ash, ` +
      "ballad, coral, echo, sage, shimmer, verse, marin, cedar and listen to it first");
  }
  const format = params.response_format ?? "mp3";
  if (format !== "wav" && format !== "pcm") {
    problems.push(`response_format "${format}": this kit returns wav or pcm (24 kHz PCM16); encode it yourself ` +
      "(for example with ffmpeg) or switch the consumer to WAV");
  }
  if (params.speed !== undefined && (params.speed < 0.25 || params.speed > 1.5)) {
    problems.push(`speed ${params.speed} is outside the Realtime range 0.25 to 1.5`);
  }
  if (problems.length > 0) throw new SpeakError(problems.join("; "), "unmapped_params");
  return {
    text: params.input,
    voice: typeof params.voice === "string" ? params.voice : { id: params.voice.id },
    ...(params.instructions ? { style: params.instructions } : {}),
    ...(params.speed === undefined ? {} : { speed: params.speed }),
    format: format as "wav" | "pcm", // the check above leaves only these two
  };
}
