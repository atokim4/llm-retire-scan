# llm-retire-scan

A command-line scanner for code that will stop working when OpenAI shuts down GPT-4o, GPT-4o mini, GPT-4.1 and
GPT-4.1 mini on **2027-01-14**. It also catches the request settings that break when you swap in the replacement,
`gpt-6-luna`. Claude model IDs and Claude 4.7+ request settings are covered too.

Changing the model ID is the easy part. `gpt-6-luna` is a reasoning model, so a request that worked on gpt-4o-mini
can fail after the swap, or start running slower and costing more:

| What your code does today | What happens on gpt-6-luna | Source |
|---|---|---|
| Chat Completions with `tools` / `functions` | Function calling on Chat Completions works only with `reasoning_effort: "none"`. The default is `medium` | [gpt-6-luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna), [latest-model guide](https://developers.openai.com/api/docs/guides/latest-model) |
| `temperature`, `top_p`, `top_logprobs`, `logprobs` | Must be removed unless reasoning effort is `none` | latest-model guide, "Unsupported parameters" |
| `max_tokens` | Deprecated in favour of `max_completion_tokens`, and on a reasoning model the limit also covers reasoning tokens | [Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) |
| No effort set at all | Runs at `medium` effort: reasoning tokens are billed as output and replies start later | gpt-6-luna model page |
| A fine-tune `ft:gpt-4o-mini-...` | Stops with its base model; gpt-6-luna has no fine-tuning endpoint | [deprecations](https://developers.openai.com/api/docs/deprecations), model page |

These behaviours come from OpenAI's documentation as of 2026-11-12. The tool's tests run against fixtures. I have not
reproduced them with live API calls, but other developers have posted the errors, for example
"Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions"
([HKUDS/DeepTutor#2439](https://github.com/HKUDS/DeepTutor/issues/2439)) and "'max_tokens' is not supported with this
model" ([nyxtron/paperless-aissist#59](https://github.com/nyxtron/paperless-aissist/issues/59)).

## What it checks

**Model IDs** in Python, JS/TS, Go, Ruby, PHP, Java, C#, Rust, Swift, Dart and Elixir string literals, and in `.env`,
YAML, TOML, JSON and INI files:

- `openai/shutdown`: gpt-4o, gpt-4o-2024-08-06, gpt-4o-2024-11-20, gpt-4o-mini(-2024-07-18), gpt-4.1(-2025-04-14),
  gpt-4.1-mini(-2025-04-14), including `openai/` and `openrouter/openai/` prefixes (LiteLLM, OpenRouter)
- `openai/fine-tune`: `ft:gpt-4o-mini-2024-07-18:org::id` and the like
- `openai/audio-shutdown`: gpt-4o-mini-tts (2027-01-06), gpt-4o-transcribe and gpt-4o-mini-transcribe (2027-02-26),
  gpt-4o-audio / realtime (2027-01-20). These have their own notices and replacements, so they are never mixed up
  with the text models
- `openai/retired`: IDs that are already shut down (gpt-4, gpt-3.5-turbo, gpt-4.1-nano, o1, o3-mini, o4-mini...)

**Call sites** (Python and JS/TS) through the OpenAI SDK (`chat.completions.create/parse/stream`,
`responses.create`), LangChain `ChatOpenAI`, LiteLLM `completion()`, and raw HTTP (`fetch`, `requests.post`,
`axios` against `/v1/chat/completions` or `/v1/responses`). For each call it works out the model (from a literal, a
constant, an env default, a parameter default, or a default set in another file of the repo) and the parameters
(including `**options` dicts and keys added to them before the call):

- `openai/tools-effort`: tools on Chat Completions without `reasoning_effort: "none"`. instructor's default
  `Mode.TOOLS` counts as a tool call, since it turns `response_model` into one
- `openai/sampling-effort`: temperature / top_p / logprobs without effort `none`
- `openai/max-tokens`: `max_tokens` on Chat Completions
- `openai/default-effort`: a call to a retiring model, or to gpt-6-luna, that sets no effort and so runs at the
  default `medium`. Responses calls with tools land here too
- `openai/tools-responses-only`: tools on Chat Completions with gpt-6-astra, gpt-6.1-sol or gpt-6.1-terra, which take
  tool calls only on the Responses API

When the model only *might* be a retiring one (it comes from a variable set elsewhere), the finding is a `warn` that
says where the default was found, and `--fix` doesn't touch it.

**Claude** (`--provider anthropic`): retired and retiring Claude IDs, custom sampling settings and
`thinking.budget_tokens` that Claude Opus 4.7+ rejects, and `content[0].text` reads that miss the text block when
thinking comes first.

## What `--fix` rewrites

- The four text model families → `gpt-6-luna` (prefixes kept: `openai/gpt-4o` → `openai/gpt-6-luna`)
- Adds `reasoning_effort="none"` / `reasoning_effort: "none"` (or `reasoning: { effort: "none" }` on Responses) right
  after the model argument, when a call sends tools or sampling settings. It follows the style of the code around
  it: kwargs, quoted JSON keys or JS keys, on the same line or a new one
- `max_tokens` → `max_completion_tokens` on those calls

It leaves alone: fine-tunes, audio models, already-retired IDs, IDs used as dict/YAML keys (price and limit tables:
swapping them would merge rows), lists that name several models (including a JSON line with a model and its
fallbacks), and anything it isn't sure about. When a call needs more than the ID swap and `--fix` can't make that
change (another effort is already set, LangChain.js options, or `**opts` defined somewhere it can't see), it keeps the
old ID too, so the call doesn't end up on gpt-6-luna half migrated. Those stay in the report. After `--fix`, only what it could not
rewrite is listed.

It skips test files, fixtures, mocks, migrations, issue templates, Markdown/docs, changelogs, comments, docstrings,
and strings that read as prose or test a name (`startswith("gpt-4o")`, `"gpt-4o" in name`, tiktoken lookups). Put
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
node src/cli.ts --model gpt-4o-mini --model gpt-6-luna # what the tool knows about an ID
```

Options: `--provider openai,anthropic` (default both), `--include-tests`, `--fail-on error|warn|never`.
Exit codes: 0 clean, 1 findings at or above `--fail-on`, 2 bad usage.

Example on a small bot:

```
| severity | rule | where | what |
|---|---|---|---|
| error | openai/shutdown (fix) | bot.py:4 | gpt-4o-mini shuts down on 2027-01-14. Replacement: gpt-6-luna, a reasoning model (default reasoning effort: medium). |
| error | openai/tools-effort (fix) | bot.py:8 | OpenAI SDK Chat Completions call sends tools. On gpt-6-luna, Chat Completions supports function calling only with reasoning_effort "none"; the default is medium. Set it to none, or move this call to the Responses API to keep reasoning. |
```

## Tried on 21 public repos

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
call-site rules. `src/anthropic/` holds the Claude rules. Tests live in `test/`.

## Licence

MIT © Sunnatulla E
