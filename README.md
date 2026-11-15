# llm-retire-scan

A command-line scanner for OpenAI and Claude model IDs that are shut down or about to be, for the request
settings that break when you swap in the replacement, and for calls to Google's Perspective API (it answers until
2026-12-31). The OpenAI dates it knows, from the
[deprecations page](https://developers.openai.com/api/docs/deprecations) as of 2026-11-14:

| Shutdown | Models | Replacement |
|---|---|---|
| **2026-12-01** | gpt-image-1.5(-2025-12-16), gpt-image-1-mini, chatgpt-image-latest | gpt-image-2.6-sunburst or gpt-image-2.6-flare |
| **2026-12-11** | gpt-5(-2025-08-07), o3(-2025-04-16) | gpt-6.1-sol |
| **2026-12-11** | gpt-5-mini(-2025-08-07) | gpt-6.1-terra |
| **2026-12-11** | gpt-5-nano(-2025-08-07) | gpt-6-luna |
| **2026-12-11** | gpt-5-pro(-2025-10-06), o3-pro(-2025-06-10) | gpt-6.1-sol with `reasoning.mode: "pro"`, Responses API only |
| 2027-01-06 | tts-1, tts-1-hd, gpt-4o-mini-tts | gpt-realtime-2.1-mini (Realtime API only, see below) |
| 2027-01-14 | gpt-4o, gpt-4o-mini, gpt-4.1, gpt-4.1-mini (and snapshots) | gpt-6-luna |
| 2027-01-20 | gpt-realtime, gpt-audio, their -mini models, gpt-4o audio/realtime | gpt-realtime-2.1(-mini), gpt-audio-1.5 |
| 2027-02-10 | gpt-image-2 | gpt-image-2.6-sunburst or -flare |
| 2027-02-26 | whisper-1, gpt-4o(-mini)-transcribe(-diarize) | gpt-transcribe or gpt-live-transcribe |
| 2027-04-01 | gpt-5.1, gpt-5.3-codex / gpt-5.4-nano | gpt-6-sol / gpt-6-luna |

IDs match whole: `gpt-5.2`, `gpt-5.6-sol` or `gpt-5.4-mini` are not `gpt-5`, and `o3-mini` / `o3-deep-research`
have their own (already past) rows. A shutdown within 30 days, or already past, is marked **urgent**; one more than
90 days out is a warning. `--today 2026-12-01` measures from another date.

Changing the model ID is the easy part. The GPT-6 replacements don't all take the same requests:

| What your code does today | gpt-6.1-sol (from gpt-5, o3) | gpt-6.1-terra (from gpt-5-mini) | gpt-6-luna (from gpt-5-nano, gpt-4o, gpt-4.1) |
|---|---|---|---|
| Chat Completions with `tools` | Tool calling needs the Responses API | Tool calling needs the Responses API | Works only with `reasoning_effort: "none"` |
| `temperature`, `top_p`, `top_logprobs`, `logprobs` | Rejected: there is no `none` effort | Need effort `none` | Need effort `none` |
| `reasoning_effort: "minimal"` | Not a value (low, medium, high, xhigh, max) | Not a value (none ... max) | Not a value (none ... max) |
| `max_tokens` on Chat Completions | Use `max_completion_tokens`; it also covers reasoning tokens | same | same |

gpt-5-pro and o3-pro have no plain replacement ID: you get the same thing with `gpt-6.1-sol` plus
`reasoning: { mode: "pro" }`, which OpenAI documents for the Responses API only. The image models move to the
Image API models gpt-image-2.6-sunburst (detailed work) or -flare (fast iteration); their model pages list Responses
as not supported, and leaving out the new `complexity` setting means `high`.

Sources: the model pages for [gpt-6.1-sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[gpt-6.1-terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra) and
[gpt-6-luna](https://developers.openai.com/api/docs/models/gpt-6-luna), the
[latest-model guide](https://developers.openai.com/api/docs/guides/latest-model) ("GPT-6 Astra, GPT-6.1 Sol, and
GPT-6.1 Terra support Chat Completions, but tool calling requires Responses"; "If your existing request uses
`minimal`, start with `low`"), the [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) (pro
mode) and the [image generation guide](https://developers.openai.com/api/docs/guides/image-generation). These
behaviours come from OpenAI's documentation. The tool's tests run against fixtures; I have not reproduced them
with live API calls. For the gpt-6-luna rules other developers have posted the errors, for example
"Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions"
([HKUDS/DeepTutor#2439](https://github.com/HKUDS/DeepTutor/issues/2439)) and "'max_tokens' is not supported with this
model" ([nyxtron/paperless-aissist#59](https://github.com/nyxtron/paperless-aissist/issues/59)).

## What it checks

**Model IDs** in Python, JS/TS, Go, Ruby, PHP, Java, C#, Rust, Swift, Dart and Elixir string literals, and in `.env`,
YAML, TOML, JSON and INI files, including `openai/` and `openrouter/openai/` prefixes (LiteLLM, OpenRouter):

- `openai/shutdown`: the text and reasoning models in the table above, with their date and replacement
- `openai/fine-tune`: `ft:gpt-4o-mini-2024-07-18:org::id` and the like (no GPT-6 model has a fine-tuning endpoint)
- `openai/image-shutdown`: GPT Image 1.5 / 1 mini / chatgpt-image-latest (2026-12-01) and gpt-image-2 (2027-02-10)
- `openai/audio-shutdown`: tts-1, whisper-1, gpt-realtime, gpt-audio, the gpt-4o speech and transcription models.
  These have their own notices and replacements, so they are never mixed up with the text models
- `openai/retired`: IDs that are already shut down (gpt-4, gpt-3.5-turbo, o1, o3-mini, gpt-5-codex, gpt-5-chat-latest...)

**Call sites** (Python and JS/TS) through the OpenAI SDK (`chat.completions.create/parse/stream`,
`responses.create`), LangChain `ChatOpenAI`, LiteLLM `completion()`, and raw HTTP (`fetch`, `requests.post`,
`axios` against `/v1/chat/completions` or `/v1/responses`). For each call it works out the model (from a literal, a
constant, an env default, a parameter default, or a default set in another file of the repo), the model it will run
on after the migration, and the parameters (including `**options` dicts and keys added to them before the call):

- `openai/tools-responses-only`: tools on Chat Completions to gpt-6.1-sol, gpt-6.1-terra or gpt-6-astra
- `openai/tools-effort`: tools on Chat Completions to gpt-6-luna / gpt-6-sol without `reasoning_effort: "none"`.
  instructor's default `Mode.TOOLS` counts as a tool call, since it turns `response_model` into one
- `openai/sampling-effort`: temperature / top_p / logprobs without effort `none` (on gpt-6.1-sol: remove them)
- `openai/effort-value`: an effort the target doesn't take (`minimal` anywhere, `none` on gpt-6.1-sol)
- `openai/pro-mode`, `openai/pro-responses-only`: gpt-5-pro / o3-pro calls
- `openai/max-tokens`: `max_tokens` on Chat Completions
- `openai/default-effort`: a gpt-4o / gpt-4.1 call, or a gpt-6-luna one, that sets no effort and so runs at the
  default `medium` (gpt-5 and o3 already reasoned at medium, so they don't get this one)

When the model only *might* be a retiring one (it comes from a variable set elsewhere), the finding is a `warn` that
says where the default was found.

**Audio calls** (Python and JS/TS, SDK `audio.speech.create` / `audio.transcriptions.create` and raw HTTP to
`/v1/audio/speech` or `/v1/audio/transcriptions`). The request settings are read from the call itself, from an
object inside it (`json={...}`), or from a form or dict passed by name and filled in earlier in the same function
(`FormData.append/.set`, aiohttp `add_field`, `data["language"] = ...`, `kwargs = dict(...)` then `**kwargs`).
Server routes (`@app.post(...)`, `router.post(...)`) and absolute URLs on hosts other than api.openai.com are
skipped:

- `openai/speech-endpoint`: every Speech API call. On 2027-01-06 the endpoint loses all three of its models, and
  the replacement isn't served there ("`gpt-realtime-2.1-mini` isn't a supported model for `/v1/audio/speech`",
  [text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech)), so the call has to move to
  the Realtime API. The finding also says when the call asks for mp3/opus/aac/flac (the default is mp3; Realtime
  sends PCM), uses `fable`, `onyx` or `nova` (not Realtime voices), or a `speed` outside 0.25 to 1.5.
- `openai/transcribe-params`: a whisper-1 or gpt-4o transcribe call (off 2027-02-26) that sends something
  gpt-transcribe treats differently, per the [speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text):
  `timestamp_granularities` ("only supported for `whisper-1`"), `language` ("For `gpt-transcribe`, `languages`
  replaces the singular `language` field"), or `verbose_json` / `srt` / `vtt` (the guide documents json and
  diarized_json for it). One finding per call, listing all of them.

Not seen: a URL kept in a class field or a variable and passed later (`fetch(this.endpoint, ...)`).

**Claude** (`--provider anthropic`): retired and retiring Claude IDs, custom sampling settings and
`thinking.budget_tokens` that Claude Opus 4.7+ rejects, and `content[0].text` reads that miss the text block when
thinking comes first.

**Perspective API** (`--provider perspective`): Google's Perspective (Comment Analyzer) API answers until **2026-12-31**
([perspectiveapi.com](https://perspectiveapi.com/)). Rules: `endpoint` (a hard-coded `commentanalyzer.googleapis.com`
URL or host), `google-client` (the Google API client for the service: `discovery.build("commentanalyzer", ...)` with
its discovery URL, `google.commentanalyzer(...)`, `commentanalyzer_v1alpha1`), `client-package` (npm
`perspective-api-client` and `@conversationai/perspectiveapi-js-client`, PyPI `perspective` and `perspectiveapi`,
Composer `bredmor/comment-analyzer` and `freema/perspective-api-bundle`, gem `google_perspective`),
`endpoint-default` (a warning: the URL is the fallback of a setting lookup such as `os.getenv("X", "https://...")`,
or the value of a name that says it is a default, like `TOXICITY_ENDPOINT_DEFAULT =` or YAML `default:`) and
`api-key` (a warning, only when nothing else in the file points at the API). Prose files (Markdown, reST, plain
text, HTML), comments and docstrings (a block string that stands alone as a statement) are skipped.
There is no `--fix` for these: the change is making the base URL configurable, then picking a replacement.

## What `--fix` rewrites

It swaps a model string only where the request stays valid on the replacement, and prints everything else as a
manual change:

- gpt-5 / o3 → `gpt-6.1-sol`, gpt-5-mini → `gpt-6.1-terra`, gpt-5-nano and the gpt-4o / gpt-4.1 families →
  `gpt-6-luna`, gpt-5.1 → `gpt-6-sol` (prefixes kept: `openai/gpt-5` → `openai/gpt-6.1-sol`)
- Adds `reasoning_effort="none"` / `reasoning_effort: "none"` (or `reasoning: { effort: "none" }` on Responses) right
  after the model argument, when a call sends tools or sampling settings and the target allows them at `none`. It
  follows the style of the code around it: kwargs, quoted JSON keys or JS keys, on the same line or a new one
- gpt-5-pro / o3-pro inside a Responses call that sets no `reasoning` yet → `gpt-6.1-sol` plus
  `reasoning: { mode: "pro" }`
- `max_tokens` → `max_completion_tokens` on those calls

It keeps the old ID when the swap alone would leave a broken call: tools on Chat Completions to a responses-only
model, temperature on gpt-6.1-sol, `minimal` effort, another effort already set where `none` is needed, LangChain.js
options, `**opts` defined somewhere it can't see, or an effort set on the options dict after it was built. It also
keeps the ID in a wrapper it doesn't know (`Agent(model="o3", tools=...)`) when the target takes tools only on
Responses, since it can't see which API the wrapper calls. That includes the default the call reads its model from, even in
another file (`OPENAI_MODEL=gpt-5` in `.env` stays when a call reading it sends tools on Chat Completions). It never
swaps fine-tunes, image and audio models, already-retired IDs, IDs used as dict/YAML keys (price and limit tables:
swapping them would merge rows), or lists that name several models (including a JSON line with a model and its
fallbacks). The same goes for catalog and price entries (`{ id: "gpt-5", label: "GPT-5" }`, `name:` next to
`context_window` or `pricing`, `tokenPriced("openai", "gpt-5", 1.25, 10)`, `Model("o3", 200000)`), constants named
after the model (`GPT_5_MINI = "gpt-5-mini"`: the value would change and the name wouldn't), TS type-map keys,
`Literal[...]` name lists and lookups like `MODELS["gpt-5"]`. Those are reported with what to do instead.
agno's `OpenAIResponses(id=...)` counts as a Responses call, so tools next to it don't hold the swap.
After `--fix`, only what it could not rewrite is listed.

Model strings in the `openai:` form (pydantic-ai, LangChain `init_chat_model`) are reported but never swapped:
those frameworks register tools and settings elsewhere (`@agent.tool`, `model_settings`). An options dict that several
calls spread never gets a setting inserted, since it would reach every one of them. A model argument that picks
between two IDs, or a default set to different IDs in different files, gets a `model-varies` warning instead of a fix.

Known gaps, where `--fix` can still swap an ID whose call needs more: options rebuilt by merging
(`params = {**base, "temperature": 0}`, `params |= ...`, `{ ...base, temperature: 0 }`), a model read from an
object built by another class (`Settings(model=...).model`), and argument lists for CLIs (`["llm", "--model",
"o3", "-o", "temperature", "0"]`). Read the diff before you commit it.

It skips test files, fixtures, mocks, migrations, issue templates, Markdown/docs, changelogs, comments, docstrings,
and strings that read as prose, regexes (`r"^gpt-5\.1$"`) or name tests (`startswith("gpt-4o")`, `"gpt-4o" in name`,
`model == "gpt-5"`, Go's `strings.HasPrefix`, prefix lists like `["gpt", "o1", "o3"]`, tiktoken lookups). Config
templates (`terraform.tfvars.example`, `app.yml.sample`) are read as the file they stand for. A bare
`o1` / `o3` counts only as the whole value of a model setting (`model="o3"`, `REASONING_MODEL = "o3"`), so
`pollutant = "o3"` or `["o1", "o2", "o3"]` stay quiet. Put
`llm-retire-scan: ignore` in a comment at the end of a line, or on its own comment line just above, to silence it.

## Speech after January 6: `kits/speech-over-realtime`

A `speak()` function for Node (TypeScript, `ws`) and Python (`websockets`) that does what an `audio.speech.create`
call did, over the Realtime API: one WebSocket session per call, `session.update` with audio output (PCM, 24 kHz)
and the voice, the text as a `conversation.item.create`, then `response.create`. It collects the
`response.output_audio.delta` chunks until `response.done` and hands back WAV bytes, the raw PCM and the model's own
transcript.

```ts
import { speak, fromSpeechParams } from "./kits/speech-over-realtime/src/index.ts";

const { wav, verbatim } = await speak({ text: "Your order has shipped.", voice: "marin" });
// Or start from the body you sent to audio.speech.create; it throws on what can't carry over:
const { format, ...options } = fromSpeechParams({ model: "tts-1", input, voice: "coral", response_format: "wav" });
```

```python
from speak_realtime import speak, from_speech_params   # Python 3.11+, websockets 14+

result = await speak("Your order has shipped.", voice="marin")
kwargs, fmt = from_speech_params({"input": text, "voice": "coral", "response_format": "wav"})
result = await speak(**kwargs)
```

Things that change, and that the kit is honest about:

- gpt-realtime-2.1-mini is a conversational voice model, not a TTS engine. The session tells it to read the text
  word for word. `verbatim` says whether its transcript matches your text (ignoring case and punctuation), so you
  can retry or log when it adds a "Sure!".
- Output is WAV or raw PCM16 (24 kHz mono). If your app plays or stores mp3/opus, encode it yourself (ffmpeg).
  `fromSpeechParams` refuses an encoded `response_format` instead of quietly returning a different format.
- `fable`, `onyx` and `nova` are Speech API voices only; `speed` goes 0.25 to 1.5 (the Speech API took up to 4.0).
- Errors come back as `SpeakError` with a `code`: the server's `error` event, a response that ends `incomplete`,
  `failed` or `cancelled` (`response_incomplete`...), a socket closed before `response.done` (`closed_early`), a
  rejected handshake (`http_401`), a malformed event (`bad_event`) or audio that isn't PCM16 (`bad_audio`), and
  `timeout`, which covers the whole call, handshake included. In Node an `AbortSignal` stops it (`aborted`); in
  Python you cancel the task. The socket is dropped as soon as `response.done` arrives.

The tests run both versions against a local fake Realtime server built from the
[Realtime conversations guide](https://developers.openai.com/api/docs/guides/realtime-conversations) and the openai
SDK's event types (the Node client events are type-checked against `openai` 7.57). **It has not been run against
the live API**: I had no key for it. Try it with your own key on a few sentences before you ship it.

## Timestamps after February 26: `kits/timed-transcript`

whisper-1 is the model that gave you timestamps. The speech-to-text guide says "the `timestamp_granularities[]`
parameter is only supported for `whisper-1`" and that existing integrations "can use the deprecated `whisper-1`
model for word or segment timestamps until February 26, 2027". The gpt-transcribe model page lists no timestamp
option, and the API reference names no response formats for it, so `srt`, `vtt` and `verbose_json` callers have no
documented equivalent. (Checked 2026-11-15, docs only.) A user of the Silo media server replayed its whisper-style
request with `model=gpt-transcribe` and got HTTP 400: "response_format 'verbose_json' is not compatible with model
'gpt-transcribe-api-ev3'. Use 'json' or 'text' instead."
([Silo-Server/silo-server#3518](https://github.com/Silo-Server/silo-server/issues/3518), their call, not mine.)

This kit gets segment timestamps back without asking the model for them. It finds the speech locally, sends each
segment to gpt-transcribe as its own request, and puts the segment's offset on the text it gets back:

1. Decode to mono PCM. WAV is read directly (8/16/24/32-bit integer or 32-bit float, any channel count); anything
   else goes through `ffmpeg` if it's installed, and fails with a `needs_ffmpeg` error if it isn't.
2. Energy VAD: 10 ms frames after a 250-3500 Hz band-pass, smoothed over three frames. A frame is speech when it
   is 3 dB over the file's noise floor (the 10th-percentile frame), but never more than 36 dB under its loud frames.
   Pauses under 350 ms are closed, blips under 150 ms dropped, and a segment over 15 s is cut at its quietest 50 ms.
3. One `/v1/audio/transcriptions` request per segment (multipart, `model=gpt-transcribe`, `response_format=json`,
   `languages[]` and `keywords[]` encoded the way the openai SDK encodes arrays), with 200 ms of padding, at most 4
   in flight, retries on 408/409/429/5xx and network errors (honouring `Retry-After`), a per-request timeout, and an
   abort that stops the rest.
4. SRT, WebVTT, or the part of whisper's `verbose_json` it can fill honestly (`task`, `language`, `duration`, `text`,
   `segments[{id, start, end, text}]`). It leaves out `tokens`, `avg_logprob`, `no_speech_prob` and `words`.

```ts
import { transcribeTimed, toSrt, toVerboseJson } from "./kits/timed-transcript/src/index.ts";

const result = await transcribeTimed("interview.mp3", { languages: ["en"] });
await writeFile("interview.srt", toSrt(result));
```

```python
from timed_transcript import transcribe_timed, to_vtt   # Python 3.10+, standard library only

result = transcribe_timed("interview.wav", languages=["ru", "uz"])
```

The Python file is a twin of the Node code, not a wrapper: same filter, thresholds and rounding. On all 14 benchmark
files below the two return identical segments, to the millisecond.

Times are computed from the frame length in samples, so 22.05 and 11.025 kHz files don't drift (a test puts one
second of speech after 10 minutes of silence at those rates). Bad settings fail early: `maxSegmentSec` under 1 s or a
`concurrency` that isn't a whole number of at least 1 throw instead of sending a request per word or none at all.
The Python VAD is plain Python: one clip's 7 benchmark files (14 minutes of audio) take about 7 s. In Python, `cancel`
returns right away but a request already sent runs on in its thread until its `timeout`.

What it can't do: word timestamps, or a cue split inside a sentence spoken without a pause. The times are where the
VAD heard speech start and stop, not an alignment of the words. Starts come out about 10 ms early and ends about
20 ms late (the smoothing and the filter), which the padding covers. Where a segment over 15 s is cut, the two
requests meet with no padding, so a word right at the cut can be clipped; the cut sits at the quietest 50 ms to make
that unlikely. Music or a second voice in the background
counts as speech.

### How close the boundaries are

Two 120 s excerpts of public-domain LibriVox readings (Stevenson's "The Song of the Morrow" and O. Henry's "The Gift
of the Magi"), decoded to 16 kHz mono. The reference pauses come from a different tool on the clean file: ffmpeg's
`silencedetect` at -45 dB and 0.35 s. Then white or pink noise is added at a fixed SNR against the speech.
"Pause-edge error" compares each found pause's edges with the reference pause. "Speech sent" is the share of
reference speech inside the audio windows that go to the API, so anything under 100% is speech that never reaches
the model. I tuned the thresholds on the first clip and only ran the second once they were set. `bench/boundaries.ts`
and `bench/parity.py` reproduce it.

| clip | noise | pauses found | extra splits | pause-edge error ms, median / p90 | speech sent |
|---|---|---|---|---|---|
| Song of the Morrow (tuning) | clean | 26/26 | 2 | 13 / 563 | 99.2% |
| | white 20 dB | 26/26 | 4 | 29 / 563 | 98.6% |
| | white 10 dB | 26/26 | 16 | 91 / 585 | 94.0% |
| | white 5 dB | 26/26 | 21 | 313 / 1327 | 83.9% |
| | pink 10 dB | 26/26 | 10 | 83 / 563 | 95.5% |
| | pink 5 dB | 26/26 | 21 | 143 / 752 | 91.8% |
| Gift of the Magi (held out) | clean | 20/20 | 4 | 17 / 90 | 99.9% |
| | white 20 dB | 20/20 | 4 | 41 / 120 | 99.7% |
| | white 10 dB | 20/20 | 8 | 105 / 247 | 98.8% |
| | white 5 dB | 20/20 | 13 | 125 / 287 | 97.6% |
| | pink 10 dB | 20/20 | 7 | 93 / 240 | 99.0% |
| | pink 5 dB | 20/20 | 10 | 115 / 257 | 98.2% |

The band-pass made the biggest difference. The first version measured raw energy with a two-level threshold, and on
the held-out clip at white 5 dB it sent 77.6% of the speech in 65 segments. It also lost a 15 s stretch of soft
reading on the first clip at 10 dB. On clean audio all 6 extra splits are real pauses
the reference skipped: 0.36 to 0.51 s gaps whose level averages -48 to -60 dBFS (the speech averages -23 to -25),
but with a peak above -45 dB somewhere inside. In loud noise the extra
splits fall inside phrases, which costs the model some context on those segments.

**Not run against the live API**: I had no key. The tests use a local fake `/v1/audio/transcriptions` that parses
the multipart body and checks every field. Try a few files with your own key before you switch.

## Run it

Node 22.18 or newer runs the TypeScript directly, so you run it from a clone (it isn't published to npm). There are
no runtime dependencies. Point it at a directory or a single file.

```sh
git clone https://github.com/atokim4/llm-retire-scan
cd llm-retire-scan
node src/cli.ts /path/to/your/project                  # Markdown table, exit 1 on errors
node src/cli.ts /path/to/your/project --json           # machine-readable
node src/cli.ts /path/to/your/project --fix            # rewrite the safe cases, list the rest
node src/cli.ts . --provider openai --fail-on warn     # CI gate, OpenAI rules only
node src/cli.ts --model gpt-5-mini --model gpt-6.1-sol # what the tool knows about an ID
```

Options: `--provider openai,anthropic,perspective` (default all three), `--include-tests`, `--fail-on error|warn|never`,
`--today YYYY-MM-DD`.
Exit codes: 0 clean, 1 findings at or above `--fail-on`, 2 bad usage.

Example on a small app (`--today 2026-11-14`):

```
| severity | rule | where | what |
|---|---|---|---|
| error (urgent) | openai/shutdown (fix) | app.ts:4 | gpt-5-mini shuts down on 2026-12-11 (in 27 days). Replacement: gpt-6.1-terra, a reasoning model with the same default effort (medium); tool calls need the Responses API. |
| warn (urgent) | openai/max-tokens (fix) | app.ts:4 | OpenAI SDK Chat Completions call sets max_tokens, deprecated in favour of max_completion_tokens; on a reasoning model the limit also has to cover reasoning tokens. |
| error (urgent) | openai/shutdown (fix) | app.ts:5 | o3-pro shuts down on 2026-12-11 (in 27 days). Replacement: gpt-6.1-sol with reasoning.mode "pro", which OpenAI documents for the Responses API only. A plain ID swap would drop pro mode, so --fix changes it only inside a Responses call it can finish. |
| error (urgent) | openai/pro-mode (fix) | app.ts:5 | OpenAI SDK Responses call: --fix swaps the model to gpt-6.1-sol and adds reasoning: { mode: "pro" } (pro mode bills more model work than standard). |
| error (urgent) | openai/image-shutdown | app.ts:6 | gpt-image-1.5 shuts down on 2026-12-01 (in 17 days). Replacement: gpt-image-2.6-sunburst or gpt-image-2.6-flare (...). Pick one by hand; --fix leaves image IDs. |

5 urgent: the model is already off or shuts down within 30 days.
```

## Tried on 11 public repos (the audio rules, v0.5)

Shallow clones, on 2026-11-15, of 11 public repos that have an open issue about the TTS or whisper-1 shutdown or
that call those endpoints (voice assistants, Telegram transcription bots, a Home Assistant TTS integration, meeting
recorders). I read every audio call-site finding in its source. The first pass had 5 false positives: the endpoint
path inside `endswith()`, a slice and a settings `.get(KEY, "https://.../audio/speech")` fallback. Raw calls now
need an HTTP callee with the URL as a positional argument. It also missed the most common real shape, a `FormData`
(JS) or `data` dict (Python) filled in before the request, which is now read back to the form's last assignment.
Final run: 11 call-site findings (5 `speech-endpoint`, 6 `transcribe-params`), all real calls, in 4 repos. Two
repos keep the URL in a field or variable and are missed (see above). On the largest repo (hermes-agent) v0.4
and v0.5 agree on every older finding, and the scan takes the same time (37 s vs 38 s).

## Tried on 32 public repos (the Perspective rules, v0.4)

32 public repos that mention Perspective and were pushed between November 2025 and November 2026 (eval harnesses,
moderation bots, forum plugins, research scripts), scanned at their branch heads on 2026-11-14 and checked by hand.
24 call Google's Perspective API from non-test code; the other 8 mention it in docs only, removed the call, or are
replacements. Each of the 24 gets at least one `endpoint`, `google-client` or `endpoint-default` finding. Of 34
such findings in the final version, 2 lines are false positives (a root-level `test.js` that isn't matched as a
test file) and 1 has the wrong severity (a Ruby constant that is the fallback of a site setting, reported as
hard-coded). 4 of the 24 already let you change the host; 20 hard-code it.
The run changed the rules: a multi-line `discovery.build(...)` is reported once, on the URL line; names and keys
that say "default" are `endpoint-default` warnings; docstrings and trailing comments are skipped. A review with
probe inputs then caught a URL being called a default because the API key on the same line came from the
environment; only a lookup's fallback counts now.

## Tried on 41 public repos (the Dec 1 / Dec 11 rules, v0.3)

Shallow clones of 41 licensed public repos pushed between August and November 2026 (agent frameworks, chat UIs,
Telegram and Discord bots, SDKs, image tools). I read every finding about the Dec 1 and Dec 11 shutdowns in its
source line. 641 findings in 28 repos: 351 requests or defaults that stop working (332 swapped by `--fix`, 19 left
with the reason), 274 catalog / price / enum entries (reported, held), 11 third-party gateway defaults, 2 capability
checks, 2 aliases and 1 false positive (an Azure deployment name in an `.env.example`). I disagree with 6 of the
339 swaps: 4 CometAPI gateway defaults, that Azure name, and a YAML list of connection models.
The run changed the scanner: 43 non-request findings went (18 regexes in one repo, Go prefix checks, comparisons,
prefix lists), 127 swaps that would have rewritten a table row or a model-named constant are now held, and 90 agno
Responses examples became fixable.

## Tried on 21 public repos (the GPT-4o rules, v0.1)

I ran it on shallow clones of 21 public repos that call OpenAI: Telegram bots, agent frameworks, RAG and eval tools,
SDK examples. Then I read every finding in its source line. On non-test code it reported 629 findings: 230
`shutdown`, 309 `retired`, 11 `audio-shutdown`, 12 `fine-tune`, and 67 call-site findings (31 `tools-effort`, 12
`sampling-effort`, 12 `max-tokens`, 12 `default-effort`). `--fix` rewrote 129 files in 18 of the repos. Every
rewritten `.py` and `.js` file still compiled, except one file that already failed `py_compile` before the change.

The review turned up false-positive patterns, and each one became a rule with a test: issue templates, Django
migrations, prose inside strings and JSON, `startswith` / `in` name tests, tiktoken lookups, name-prefix tuples like
`("gpt-", "o1")`, and tool mentions in docstrings. It also turned up blind spots, now covered: tools hidden in
`**create_params` dicts (Swarm), sampling settings in a module-level options dict (a Telegram bot), parameter defaults
and instructor's `Mode.TOOLS`. Known gaps: the Vercel AI SDK (`openai("gpt-4o")`) and other wrappers are reported
by ID only, without call-site checks. A model read from a nested config lookup (`config["model"]`) isn't traced
across files.

## Develop

```sh
npm ci
npm run check   # tsc --noEmit (strict) + vitest

cd kits/speech-over-realtime && npm ci && npm run check          # Node speak(), against the fake server
cd python && python -m pip install -r requirements.txt pytest && python -m pytest

cd kits/timed-transcript && npm ci && npm run check              # Node, against the fake transcription API
python3 -m unittest discover -s python                           # Python twin, standard library only
FFMPEG=$(command -v ffmpeg) npm test                             # also runs the ffmpeg decode test
node bench/boundaries.ts clip.wav "$(command -v ffmpeg)" /tmp/out && python3 bench/parity.py /tmp/out
```

`src/source.ts` is a small Python/JS lexer (strings, comments, brackets). `src/openai/` holds the model table and the
call-site rules. `src/openai/audio.ts` the Speech and transcription call rules. `src/anthropic/` holds the Claude rules, `src/perspective/` the Perspective API rules. Tests live in
`test/`.

## Licence

MIT © Sunnatulla E
