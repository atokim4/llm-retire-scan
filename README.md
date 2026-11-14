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
| 2027-01-06 | tts-1, tts-1-hd, gpt-4o-mini-tts | gpt-realtime-2.1-mini |
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
```

`src/source.ts` is a small Python/JS lexer (strings, comments, brackets). `src/openai/` holds the model table and the
call-site rules. `src/anthropic/` holds the Claude rules, `src/perspective/` the Perspective API rules. Tests live in
`test/`.

## Licence

MIT © Sunnatulla E
