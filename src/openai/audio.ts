import { CODE, entries, enclosingOpen, lineOf, matchingClose, type Entry, type Source } from "../source.ts";
import type { Finding } from "../types.ts";
import { daysUntil, noticeFor, SOON_DAYS, URGENT_DAYS, whenText } from "./models.ts";

/**
 * Call-site rules for the Audio API (see DOCS-NOTES.md, "Speech and transcription"):
 * - /v1/audio/speech loses every model it has on 2027-01-06, and the replacement only runs on the Realtime API,
 *   so each speech call is a code change, whatever model it names.
 * - whisper-1 and the gpt-4o transcribe models stop on 2027-02-26. On gpt-transcribe, `timestamp_granularities`
 *   isn't supported, `languages` replaces `language`, and only json / diarized_json are documented.
 */

const SPEECH_DATE = "2027-01-06";
const TRANSCRIBE_DATE = "2027-02-26";
/** Speech API voices the Realtime voice list doesn't have. */
const SPEECH_ONLY_VOICES = new Set(["fable", "onyx", "nova"]);
/** Formats shown only with whisper-1 in the speech-to-text guide; none is documented for gpt-transcribe. */
const WHISPER_FORMATS = new Set(["verbose_json", "srt", "vtt"]);

type Endpoint = "speech" | "transcriptions";

const SDK_CALLS: { re: RegExp; endpoint: Endpoint }[] = [
  { re: /\.audio\.speech\.(?:with_streaming_response\.|with_raw_response\.)?create\s*\(/g, endpoint: "speech" },
  { re: /\.audio\.transcriptions\.(?:with_raw_response\.)?create\s*\(/g, endpoint: "transcriptions" },
];
const RAW_ENDPOINT = /\/(?:v1\/)?audio\/(speech|transcriptions)(?![\w/])/;
/**
 * An HTTP-sending callee: `fetch`, `openaiFetch`, `requests.post`, `client.request`, `urlopen`, `Request`, `axios`.
 * Group 1 is the receiver (`app` in `app.post`), group 2 the name.
 */
const HTTP_CALLEE = /(@?)(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*$/;
const HTTP_NAME = /^(?:fetch|[a-z][\w$]*Fetch|post|request|Request|urlopen|axios|got|ky|ofetch|\$fetch)$/;
/** Receivers that define server routes (`app.post("/v1/audio/speech", handler)`), not requests. */
const ROUTER = /^(?:app|router|api|server|bp|blueprint|fastify|routes?|r)$/i;
/** Where a function body starts: `def f(`, `function f(`, `name(args) {`, `=> {`. */
const FUNCTION_START =
  /\bdef\s+\w+\s*\(|\bfunction\b[^(\n]*\(|(?<![\w$])(?!(?:if|for|while|switch|catch|with)\b)[A-Za-z_$][\w$]*\s*\([^()\n]*\)\s*(?::\s*[^{=;\n]+)?\{|=>\s*\{?/g;
/** How far back from a call to look for the form or dict its body is built in. */
const BUILD_LINES = 40;
/** ...and never more than this many characters (a minified line is one "line"). */
const BUILD_CHARS = 8_000;

/** One request setting: its key, the source text of its value, and whether that text is a plain string. */
interface Setting {
  key: string;
  value: string;
  literal?: string;
}

interface Call {
  at: number;
  endpoint: Endpoint;
  settings: Setting[];
  /** Some settings come from a place this tool can't read (`**kwargs`, `...opts`, an opaque body). */
  open: boolean;
}

const literalOf = (value: string) => /^(["'`])([^"'`\\]*)\1$/.exec(value.trim())?.[2];

function settingsIn(src: Source, list: readonly Entry[]): Setting[] {
  return list.filter((e) => e.key).map((e) => {
    const value = src.text.slice(e.valueStart, e.end).trim();
    const literal = literalOf(value);
    return literal === undefined ? { key: e.key!, value } : { key: e.key!, value, literal };
  });
}

/**
 * Settings built in the lines before the call on `name`: `name = {...}`, `name["key"] = value`,
 * `name.append("key", value)` (FormData / multipart). Returns null when nothing builds `name` there.
 */
function builtBefore(src: Source, name: string, before: number): Setting[] | null {
  let from = before;
  for (let i = 0; i < BUILD_LINES && from > 0; i += 1) from = src.text.lastIndexOf("\n", from - 1);
  from = Math.max(from, before - BUILD_CHARS);
  const id = name.replace(/[$]/g, "\\$");
  // Stay inside the function that makes the call: a form built in another function doesn't count.
  const windowStart = Math.max(from, 0);
  for (const m of src.text.slice(windowStart, before).matchAll(FUNCTION_START)) {
    const at = windowStart + m.index;
    if (src.mask[at] === CODE) from = at + m[0].length;
  }
  // Then start at the last time `name` is (re)assigned, so an earlier form doesn't count either.
  let base = Math.max(from, 0);
  const reassign = new RegExp(`(?<![\\w$.])${id}\\s*(?::[^=\\n]+)?=(?![=>])`, "g");
  for (const m of src.text.slice(base, before).matchAll(reassign)) {
    if (src.mask[base + m.index] === CODE) from = base + m.index;
  }
  base = Math.max(from, 0);
  const region = src.text.slice(base, before);
  const settings: Setting[] = [];
  let found = false;
  const code = (at: number) => src.mask[base + at] === CODE;
  for (const m of region.matchAll(new RegExp(`(?<![\\w$.])${id}\\s*(?::[^=\\n]+)?=\\s*(?:dict\\s*)?([{(])`, "g"))) {
    if (!code(m.index)) continue;
    const open = base + m.index + m[0].length - 1;
    const close = matchingClose(src, open);
    if (close === -1) continue;
    found = true;
    settings.push(...settingsIn(src, entries(src, open, close)));
  }
  const assign = new RegExp(`(?<![\\w$.])${id}\\s*\\[\\s*(["'])([\\w\\[\\]]+)\\1\\s*\\]\\s*=(?!=)\\s*([^\\n;]+)`, "g");
  // `form.append("k", v)`, `.set(...)`, aiohttp `form.add_field("k", v)`; the value ends at a comma or paren, so
  // several calls on one line and a call split over lines both read.
  const append = new RegExp(`(?<![\\w$.])${id}\\.(?:append|set|add_field)\\(\\s*(["'])([\\w\\[\\]]+)\\1\\s*,\\s*([^,)\\n]+)`, "g");
  for (const re of [assign, append]) {
    for (const m of region.matchAll(re)) {
      if (!code(m.index)) continue;
      found = true;
      const value = m[3]!.trim();
      const literal = literalOf(value);
      settings.push(literal === undefined ? { key: m[2]!, value } : { key: m[2]!, value, literal });
    }
  }
  return found ? settings : null;
}

/**
 * The settings a call sends: its own arguments, an object inside them that holds `model` (`json={...}`,
 * `{ body: {...} }`), or a form / dict passed by name (`data=data`, `body: form`, `JSON.stringify(body)`).
 */
function callSettings(src: Source, open: number, at: number): Pick<Call, "settings" | "open"> {
  const close = matchingClose(src, open);
  if (close === -1) return { settings: [], open: true };
  const top = entries(src, open, close);
  const own = settingsIn(src, top);
  const spread = top.some((e) => e.style === "spread");
  if (own.some((s) => s.key === "model")) return { settings: own, open: spread };
  // Look one object deep (`json={...}`, `fetch(url, { body: form })`), then at names passed as the body.
  const candidates: Entry[] = [];
  for (const entry of top) {
    candidates.push(entry);
    const value = src.text.slice(entry.valueStart, entry.end).trim();
    if (!value.startsWith("{") && !value.startsWith("dict(")) continue;
    const offset = entry.valueStart + src.text.slice(entry.valueStart, entry.end).search(/\S/);
    const inner = value.startsWith("{") ? offset : offset + 4;
    const nested = entries(src, inner, matchingClose(src, inner));
    const settings = settingsIn(src, nested);
    if (settings.some((s) => s.key === "model")) return { settings, open: spread };
    candidates.push(...nested);
  }
  for (const entry of candidates) {
    if (entry.style === "positional") continue;
    // `data=form`, `body: JSON.stringify(body)`, or a spread `**kwargs` / `...params` built just before.
    const value = src.text.slice(entry.valueStart, entry.end).trim().replace(/^(?:\*\*|\.\.\.)/, "");
    const name = /^(?:JSON\.stringify\(\s*)?([A-Za-z_$][\w$]*)\s*\)?$/.exec(value)?.[1];
    const built = name ? builtBefore(src, name, at) : null;
    if (built?.some((s) => s.key === "model")) {
      const others = top.some((e) => e.style === "spread" && e !== entry);
      return { settings: [...built, ...own], open: others };
    }
  }
  return { settings: own, open: true };
}

function findCalls(src: Source): Call[] {
  const calls: Call[] = [];
  const seen = new Set<number>();
  const add = (at: number, open: number, endpoint: Endpoint) => {
    if (seen.has(open)) return;
    seen.add(open);
    calls.push({ at, endpoint, ...callSettings(src, open, at) });
  };
  for (const { re, endpoint } of SDK_CALLS) {
    for (const m of src.text.matchAll(re)) {
      if (src.mask[m.index] === CODE) add(m.index, m.index + m[0].length - 1, endpoint);
    }
  }
  for (const literal of src.strings) {
    const hit = RAW_ENDPOINT.exec(literal.value);
    if (!hit || literal.block) continue;
    const open = enclosingOpen(src, literal.start);
    if (open === -1 || src.text[open] !== "(") continue;
    const callee = HTTP_CALLEE.exec(src.text.slice(Math.max(0, open - 60), open));
    if (!callee || callee[1] || !HTTP_NAME.test(callee[3]!) || ROUTER.test(callee[2] ?? "")) continue;
    // Another provider's absolute URL (ElevenLabs, a local server) has its own schedule.
    const host = /^https?:\/\/([^/:]+)/.exec(literal.value)?.[1];
    if (host !== undefined && host !== "api.openai.com") continue;
    // The URL has to be a positional argument of the request: `.get(KEY, "https://.../audio/speech")` with a
    // non-HTTP callee is already out; `fetch(url, { headers: { Referer: ".../audio/speech" } })` is too.
    const arg = entries(src, open, matchingClose(src, open)).find((e) => e.start <= literal.start && literal.start < e.end);
    if (arg?.style === "positional") add(literal.start, open, hit[1] as Endpoint);
  }
  return calls;
}

export function scanAudioCalls(file: string, src: Source, today: string): Finding[] {
  const findings: Finding[] = [];
  for (const call of findCalls(src)) {
    const get = (key: string) => call.settings.find((e) => e.key === key);
    const model = get("model")?.literal;
    const date = call.endpoint === "speech" ? SPEECH_DATE : TRANSCRIBE_DATE;
    const days = daysUntil(date, today);
    const finding = (rule: string, message: string): Finding => ({
      file, line: lineOf(src.text, call.at), provider: "openai", rule, message, urgent: days <= URGENT_DAYS,
      severity: days > SOON_DAYS ? "warn" : "error",
    });

    if (call.endpoint === "speech") {
      const notes: string[] = [];
      const voice = get("voice")?.literal;
      if (voice && SPEECH_ONLY_VOICES.has(voice)) notes.push(`voice "${voice}" is not one of the Realtime voices`);
      // Left out, response_format is mp3, unless the call has settings this tool can't read.
      const format = get("response_format") ? get("response_format")!.literal : call.open ? undefined : "mp3";
      if (format && format !== "wav" && format !== "pcm") {
        notes.push(`Realtime returns PCM audio (24 kHz), so the ${format} this call gets needs its own encoder`);
      }
      const speed = Number(get("speed")?.value);
      if (get("speed") && Number.isFinite(speed) && (speed < 0.25 || speed > 1.5)) {
        notes.push(`speed ${speed} is outside the Realtime range 0.25 to 1.5`);
      }
      findings.push(finding("speech-endpoint",
        `Speech API call: if it goes to OpenAI, /v1/audio/speech loses all of its models (tts-1, tts-1-hd, gpt-4o-mini-tts) on ` +
        `${SPEECH_DATE} (${whenText(days)}). The replacement, gpt-realtime-2.1-mini, isn't supported on that ` +
        "endpoint, so this call has to move to the Realtime API; a model swap won't do it." +
        (notes.length ? ` Also: ${notes.join("; ")}.` : "")));
      continue;
    }

    // Transcriptions: the rules only bite when the call leaves a retiring model (or the model is set elsewhere).
    if (model !== undefined && noticeFor(model)?.date !== TRANSCRIBE_DATE) continue;
    const subject = model
      ? `Transcription call on ${model}, which shuts down on ${TRANSCRIBE_DATE} (${whenText(days)})`
      : "Transcription call whose model is set elsewhere: if that is whisper-1 or a gpt-4o transcribe model " +
        `(off on ${TRANSCRIBE_DATE}, ${whenText(days)})`;
    const problems: string[] = [];
    if (get("timestamp_granularities") || get("timestamp_granularities[]") || get("timestampGranularities")) {
      problems.push("timestamp_granularities is supported only on whisper-1, so word and segment timestamps go away");
    }
    // Code that already sends `languages` (a key, or inside `extra_body={"languages": [...]}`) has handled it.
    const sendsLanguages = call.settings.some((e) =>
      e.key === "languages" || e.key === "languages[]" || /["']languages(?:\[\])?["']/.test(e.value));
    if (get("language") && !sendsLanguages) {
      problems.push("gpt-transcribe takes `languages` (a list) in place of `language`; don't send both");
    }
    const format = get("response_format")?.literal;
    if (format && WHISPER_FORMATS.has(format)) {
      problems.push(`response_format "${format}" isn't documented for gpt-transcribe (json and diarized_json are)`);
    }
    if (problems.length === 0) continue;
    findings.push(finding("transcribe-params",
      `${subject}, moving it to gpt-transcribe changes more than the ID: ${problems.join("; ")}.`));
  }
  return findings;
}
