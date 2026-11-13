import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { describeOpenAIModel } from "../src/openai/describe.ts";
import { applyEdits, scanDirectory, scanText } from "../src/scan.ts";

const TODAY = "2026-11-14";
const scan = (file: string, text: string) => scanText(file, text, ["openai"], undefined, TODAY);
const rules = (file: string, text: string) => scan(file, text).findings.map((f) => `${f.line}:${f.rule}`);
const fixed = (file: string, text: string) => applyEdits(text, scan(file, text).edits);

describe("model IDs", () => {
  it("flags each GPT-4o / GPT-4.1 text ID with the 2027-01-14 date and gpt-6-luna", () => {
    for (const id of ["gpt-4o", "gpt-4o-2024-11-20", "gpt-4o-mini-2024-07-18", "gpt-4.1", "gpt-4.1-mini"]) {
      const [finding] = scan("config.py", `MODEL = "${id}"\n`).findings;
      expect(finding).toMatchObject({ rule: "shutdown", severity: "error", fixable: true });
      expect(finding?.message).toContain("2027-01-14");
      expect(finding?.message).toContain("gpt-6-luna");
    }
  });

  it("keeps the speech and transcription models on their own rule and dates", () => {
    const text = 'TTS = "gpt-4o-mini-tts"\nSTT = "gpt-4o-transcribe"\nDIAR = "gpt-4o-transcribe-diarize"\n';
    const { findings, edits } = scan("audio.py", text);
    expect(findings.map((f) => f.rule)).toEqual(["audio-shutdown", "audio-shutdown", "audio-shutdown"]);
    expect(findings[0]?.message).toContain("2027-01-06");
    expect(findings[1]?.message).toContain("2027-02-26");
    expect(edits).toEqual([]);
  });

  it("reads LiteLLM / OpenRouter prefixes and keeps them in the fix", () => {
    const text = 'a = "openai/gpt-4o"\nb = "openrouter/openai/gpt-4o-mini"\n';
    expect(rules("m.py", text)).toEqual(["1:shutdown", "2:shutdown"]);
    expect(fixed("m.py", text)).toBe('a = "openai/gpt-6-luna"\nb = "openrouter/openai/gpt-6-luna"\n');
  });

  it("doesn't swap table keys or IDs in a list of several models", () => {
    const py = 'PRICES = {\n    "gpt-4o": 2.5,\n    "gpt-4o-mini": 0.15,\n}\nMODELS = ["gpt-4o", "gpt-4o-mini"]\nONE = ["gpt-4.1"]\n';
    const { findings, edits } = scan("prices.py", py);
    expect(findings.map((f) => `${f.line}:${f.fixable}`)).toEqual(["2:false", "3:false", "5:false", "5:false", "6:true"]);
    expect(findings[0]?.message).toContain("It is a key");
    expect(findings[2]?.message).toContain("list of several models");
    expect(edits).toHaveLength(1);
    expect(scan("models.yml", "gpt-4o:\n  price: 1\nmodels: [gpt-4o, gpt-4.1]\ndefault: gpt-4o\n").findings
      .map((f) => `${f.line}:${f.fixable}`)).toEqual(["1:false", "3:false", "3:false", "4:true"]);
    expect(scan("p.json", '{"gpt-4o": {"in": 2.5}, "model": "gpt-4o"}\n').findings.map((f) => f.fixable)).toEqual([false, true]);
  });

  it("reports fine-tunes without swapping them", () => {
    const text = 'MODEL = "ft:gpt-4o-mini-2024-07-18:acme::9abcDEF"\n';
    const { findings, edits } = scan("bot.py", text);
    expect(findings).toMatchObject([{ rule: "fine-tune", fixable: false }]);
    expect(findings[0]?.message).toContain("no fine-tuning endpoint");
    expect(edits).toEqual([]);
  });

  it("flags models that are already shut down", () => {
    expect(rules("a.ts", 'const m = "gpt-3.5-turbo";\nconst n = "gpt-4.1-nano";\n')).toEqual(["1:retired", "2:retired"]);
  });

  it("ignores docs, changelogs, comments, docstrings, labels, Azure and Bedrock IDs", () => {
    expect(rules("README.md", "Uses `gpt-4o-mini` by default.\n")).toEqual([]);
    expect(rules("CHANGELOG", "- switched to gpt-4o\n")).toEqual([]);
    expect(rules("docs/notes.txt", "gpt-4o\n")).toEqual([]);
    const py = '# default was "gpt-4o"\ndef f():\n    """Calls gpt-4o-mini."""\nlabel = "GPT-4o"\naz = "azure/gpt-4o"\nbr = "openai.gpt-4o"\n';
    expect(rules("x.py", py)).toEqual([]);
    expect(rules("x.ts", '// "gpt-4o"\n/* gpt-4.1 */\nconst label = "GPT-4.1 mini";\n')).toEqual([]);
  });

  it("skips name tests, tokenizer lookups and prose in JSON/YAML", () => {
    const py = [
      'if name.startswith(("o3", "o4", "gpt-5", "o1")):',
      '    pass',
      'if "gpt-4o" in model_name:',
      '    enc = tiktoken.encoding_for_model("gpt-4o")',
      'llm.tiktoken_model_name = "gpt-4o"',
      '',
    ].join("\n");
    expect(rules("x.py", py)).toEqual([]);
    expect(rules("x.ts", 'if (id.startsWith("gpt-4o")) {}\n')).toEqual([]);
    expect(rules("x.py", 'PREFIXES = ("gpt-", "o1", "o3")\n')).toEqual([]);
    expect(rules("ledger.json", '{"reason": "Retired o1 generation; use gpt-4o-mini instead.", "model": "gpt-4o"}\n'))
      .toEqual(["1:shutdown"]);
    expect(rules("api.yml", "description: The model name, e.g. 'gpt-4o-mini'\nlabel: gpt-4o\n")).toEqual(["2:shutdown"]);
    expect(rules("models.yml", 'available: ["gpt-4o-mini", "openai/gpt-5.5"]\n')).toEqual(["1:shutdown"]);
    expect(rules("x.py", 'HELP = \'(e.g. "openai/gpt-4o" or "anthropic/claude-x")\'\n')).toEqual([]);
  });

  it("honours an ignore comment on the line or the line above", () => {
    const text = 'A = "gpt-4o"  # llm-retire-scan: ignore\n# llm-retire-scan: ignore\nB = "gpt-4o"\nC = "gpt-4o"\n';
    const { findings, edits } = scan("x.py", text);
    expect(findings.map((f) => f.line)).toEqual([4]);
    expect(edits).toHaveLength(1);
  });

  it("reads config files and other languages", () => {
    expect(rules(".env.example", "# OPENAI_MODEL=gpt-4o\nOPENAI_MODEL=gpt-4o-mini\n")).toEqual(["2:shutdown"]);
    expect(rules("config.yaml", "llm:\n  model: gpt-4.1-mini\n")).toEqual(["2:shutdown"]);
    expect(rules("main.go", '// gpt-4o\nmodel := "gpt-4o"\n')).toEqual(["2:shutdown"]);
  });
});

describe("Chat Completions call sites (Python)", () => {
  it("adds reasoning_effort none when a call sends tools", () => {
    const text = [
      "from openai import OpenAI",
      "client = OpenAI()",
      "resp = client.chat.completions.create(",
      '    model="gpt-4o-mini",',
      "    messages=messages,",
      "    tools=TOOLS,",
      ")",
      "",
    ].join("\n");
    expect(rules("bot.py", text)).toEqual(["3:tools-effort", "4:shutdown"]);
    expect(fixed("bot.py", text)).toContain('    model="gpt-6-luna",\n    reasoning_effort="none",\n    messages=messages,');
  });

  it("adds reasoning_effort none for temperature and renames max_tokens", () => {
    const text = 'r = client.chat.completions.create(model="gpt-4.1", messages=m, temperature=0.2, max_tokens=500)\n';
    expect(rules("a.py", text)).toEqual(["1:shutdown", "1:sampling-effort", "1:max-tokens"]);
    expect(fixed("a.py", text)).toBe(
      'r = client.chat.completions.create(model="gpt-6-luna", reasoning_effort="none", messages=m, temperature=0.2, max_completion_tokens=500)\n',
    );
  });

  it("only warns about the default effort when nothing else breaks", () => {
    const text = 'r = client.chat.completions.create(model="gpt-4o", messages=m)\n';
    const { findings } = scan("a.py", text);
    expect(findings.map((f) => `${f.rule}:${f.severity}`)).toEqual(["shutdown:error", "default-effort:warn"]);
    expect(fixed("a.py", text)).toBe('r = client.chat.completions.create(model="gpt-6-luna", messages=m)\n');
  });

  it("resolves a model constant defined in the same file", () => {
    const text = 'MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")\n\nr = client.chat.completions.create(model=MODEL, messages=m, tools=t)\n';
    expect(rules("a.py", text)).toEqual(["1:shutdown", "3:tools-effort"]);
    expect(fixed("a.py", text)).toContain("create(model=MODEL, reasoning_effort=\"none\", messages=m");
  });

  it("follows a parameter default and the keys of a spread options dict", () => {
    const text = [
      'OPTIONS = {"temperature": 0.7, "max_tokens": 1000}',
      "class ChatGPT:",
      '    def __init__(self, model="gpt-4o-mini"):',
      "        self.model = model",
      "    async def send(self, messages):",
      "        return await self._client.chat.completions.create(model=self.model, messages=messages, **OPTIONS)",
      "",
    ].join("\n");
    expect(rules("bot.py", text)).toEqual(["3:shutdown", "6:sampling-effort", "6:max-tokens"]);
    const after = fixed("bot.py", text);
    expect(after).toContain('OPTIONS = {"temperature": 0.7, "max_completion_tokens": 1000}');
    expect(after).toContain('create(model=self.model, reasoning_effort="none", messages=messages, **OPTIONS)');
  });

  it("warns without fixing when the model is a variable it can't trace", () => {
    const text = 'CHOICES = ["gpt-4o", "gpt-4o-mini"]\nr = client.chat.completions.create(model=self.model, messages=m, tools=t)\n';
    const { findings, edits } = scan("a.py", text);
    const call = findings.find((f) => f.rule === "tools-effort");
    expect(call).toMatchObject({ severity: "warn", fixable: false });
    expect(edits.every((e) => e.text === "gpt-6-luna")).toBe(true);
  });

  it("leaves calls that already set reasoning_effort none alone, and won't override another effort", () => {
    expect(rules("a.py", 'client.chat.completions.create(model="gpt-6-luna", reasoning_effort="none", tools=t, temperature=0)\n')).toEqual([]);
    const low = 'client.chat.completions.create(model="gpt-6-luna", reasoning_effort="low", tools=t)\n';
    expect(scan("a.py", low).findings).toMatchObject([{ rule: "tools-effort", severity: "error", fixable: false }]);
    expect(scan("a.py", low).edits).toEqual([]);
  });

  it("checks code already moved to gpt-6-luna, and Responses-only GPT-6 models", () => {
    const luna = 'client.chat.completions.create(model="gpt-6-luna", messages=m, tools=t)\n';
    expect(rules("a.py", luna)).toEqual(["1:tools-effort"]);
    expect(fixed("a.py", luna)).toContain('model="gpt-6-luna", reasoning_effort="none"');
    expect(rules("a.py", 'client.chat.completions.create(model="gpt-6-astra", tools=t)\n')).toEqual(["1:tools-responses-only"]);
  });

  it("handles LangChain ChatOpenAI with bind_tools, and LiteLLM", () => {
    const lc = 'from langchain_openai import ChatOpenAI\nllm = ChatOpenAI(model="gpt-4o", temperature=0)\nagent = llm.bind_tools(tools)\n';
    expect(rules("lc.py", lc)).toEqual(["2:shutdown", "2:tools-effort", "2:sampling-effort"]);
    expect(fixed("lc.py", lc)).toContain('ChatOpenAI(model="gpt-6-luna", reasoning_effort="none", temperature=0)');

    const lite = 'from litellm import completion\nr = completion(model="openai/gpt-4o-mini", messages=m, tools=t)\n';
    expect(rules("l.py", lite)).toEqual(["2:shutdown", "2:tools-effort"]);
    expect(fixed("l.py", lite)).toContain('completion(model="openai/gpt-6-luna", reasoning_effort="none", messages=m');
  });

  it("treats instructor's response_model as a tool call in the default Mode.TOOLS", () => {
    const text = 'import instructor\nclient = instructor.from_openai(OpenAI())\nu = client.chat.completions.create(model="gpt-4o-mini", response_model=User, messages=m)\n';
    expect(rules("x.py", text)).toEqual(["3:shutdown", "3:tools-effort"]);
    const json = text.replace("from_openai(OpenAI())", "from_openai(OpenAI(), mode=instructor.Mode.JSON)");
    expect(rules("x.py", json)).toEqual(["3:shutdown", "3:default-effort"]);
  });

  it("finds raw HTTP calls and mirrors quoted keys", () => {
    const text = 'r = requests.post("https://api.openai.com/v1/chat/completions", json={"model": "gpt-4o", "messages": m, "tools": t})\n';
    expect(rules("raw.py", text)).toEqual(["1:shutdown", "1:tools-effort"]);
    expect(fixed("raw.py", text)).toContain('{"model": "gpt-6-luna", "reasoning_effort": "none", "messages": m');
  });
});

describe("call sites (JavaScript / TypeScript)", () => {
  it("adds reasoning_effort on its own line in a multi-line object", () => {
    const text = [
      "const res = await openai.chat.completions.create({",
      '  model: "gpt-4.1-mini",',
      "  messages,",
      "  tools,",
      "  max_tokens: 300,",
      "});",
      "",
    ].join("\n");
    expect(rules("chat.ts", text)).toEqual(["1:tools-effort", "1:max-tokens", "2:shutdown"]);
    expect(fixed("chat.ts", text)).toBe([
      "const res = await openai.chat.completions.create({",
      '  model: "gpt-6-luna",',
      '  reasoning_effort: "none",',
      "  messages,",
      "  tools,",
      "  max_completion_tokens: 300,",
      "});",
      "",
    ].join("\n"));
  });

  it("reads the model from an env default and a fetch body", () => {
    const text = [
      'const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";',
      'const r = await fetch("https://api.openai.com/v1/chat/completions", {',
      '  method: "POST",',
      "  body: JSON.stringify({ model: MODEL, messages, tools, temperature: 0.3 }),",
      "});",
      "",
    ].join("\n");
    expect(rules("api.js", text)).toEqual(["1:shutdown", "2:tools-effort", "2:sampling-effort"]);
    expect(fixed("api.js", text)).toContain('JSON.stringify({ model: MODEL, reasoning_effort: "none", messages, tools');
  });

  it("uses the Responses shape for sampling on responses.create, and doesn't flag tools there", () => {
    const text = 'await client.responses.create({ model: "gpt-4o", input, tools, temperature: 0 });\n';
    expect(rules("r.ts", text)).toEqual(["1:shutdown", "1:sampling-effort"]);
    expect(fixed("r.ts", text)).toContain('{ model: "gpt-6-luna", reasoning: { effort: "none" }, input');
  });

  it("reports LangChain.js without rewriting its options", () => {
    const text = 'const llm = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });\nconst bound = llm.bindTools(tools);\n';
    const { findings, edits } = scan("lc.ts", text);
    expect(findings.every((f) => !f.fixable)).toBe(true);
    // Swapping the ID without the effort would send temperature 0 to a model that rejects it.
    expect(edits).toEqual([]);
    expect(findings.find((f) => f.rule === "shutdown")?.message).toContain("--fix leaves this call");
  });

  it("is not fooled by quotes inside regex literals and template strings", () => {
    const text = 'const re = /["\']/g;\nconst s = `prefix ${"x"}`;\nconst m = "gpt-4o";\n';
    expect(rules("x.js", text)).toEqual(["3:shutdown"]);
  });
});

describe("calls --fix can't finish", () => {
  it("keeps the old ID when the call sets another effort with tools", () => {
    const text = 'client.chat.completions.create(model="gpt-4o", tools=t, reasoning_effort="low")\n';
    const { findings, edits } = scan("a.py", text);
    expect(edits).toEqual([]);
    expect(findings.map((f) => `${f.rule}:${f.fixable}`)).toEqual(["shutdown:false", "tools-effort:false"]);
  });

  it("keeps the old ID when options come from a dict it can't see", () => {
    const text = 'def ask(opts):\n    return client.chat.completions.create(model="gpt-4o", messages=[], **opts)\n';
    const { findings, edits } = scan("a.py", text);
    expect(edits).toEqual([]);
    expect(findings.find((f) => f.rule === "shutdown")?.message).toContain("spreads options defined elsewhere");
  });

  it("warns about the default effort on Responses calls with tools and on gpt-6-luna calls", () => {
    expect(rules("a.py", 'client.responses.create(model="gpt-4.1", input=x, tools=t)\n'))
      .toEqual(["1:shutdown", "1:default-effort"]);
    expect(rules("a.py", 'client.chat.completions.create(model="gpt-6-luna", messages=m)\n')).toEqual(["1:default-effort"]);
  });

  it("doesn't make a JSON fallback equal to the primary model", () => {
    const { findings, edits } = scan("router.json", '{"model": "gpt-4o", "fallbacks": ["gpt-4o-mini"]}\n');
    expect(findings.map((f) => f.fixable)).toEqual([false, false]);
    expect(edits).toEqual([]);
  });

  it("limits a trailing ignore comment to its own line", () => {
    const text = 'x = "gpt-4o"  # llm-retire-scan: ignore\ny = "gpt-4o"\n';
    expect(rules("a.py", text)).toEqual(["2:shutdown"]);
  });
});

describe("fixes", () => {
  it("leaves nothing fixable behind once applied", () => {
    const text = 'r = client.chat.completions.create(model="gpt-4o-mini", messages=m, tools=t, temperature=0, max_tokens=9)\n';
    const after = fixed("a.py", text);
    expect(scan("a.py", after).findings).toEqual([]);
  });
});

describe("describeOpenAIModel", () => {
  it("explains retiring, retired, replacement and unknown IDs", () => {
    expect(describeOpenAIModel("gpt-4o-mini", TODAY)).toContain("shuts down on 2027-01-14 (in 61 days); replacement gpt-6-luna");
    expect(describeOpenAIModel("gpt-4")).toContain("shut down on 2026-10-23");
    expect(describeOpenAIModel("gpt-6-luna")).toContain('reasoning_effort "none"');
    expect(describeOpenAIModel("gpt-5.6-terra")).toContain("not on the OpenAI shutdown list");
    expect(describeOpenAIModel("ft:gpt-4o-mini-2024-07-18:a::b")).toContain("no drop-in replacement");
  });
});

describe("scanDirectory --fix", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("rewrites files in place and reports which ones", async () => {
    root = await mkdtemp(join(tmpdir(), "llm-retire-scan-"));
    await writeFile(join(root, "bot.py"), 'client.chat.completions.create(model="gpt-4o", tools=t)\n');
    await writeFile(join(root, "README.md"), "We use gpt-4o.\n");
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "tests", "test_bot.py"), 'MODEL = "gpt-4o"\n');
    await mkdir(join(root, "app", "migrations"), { recursive: true });
    await writeFile(join(root, "app", "migrations", "0001_initial.py"), 'default="gpt-4o"\n');

    const result = await scanDirectory(root, { providers: ["openai"], fix: true });

    expect(result.fixed).toEqual(["bot.py"]);
    expect(await readFile(join(root, "bot.py"), "utf8")).toBe(
      'client.chat.completions.create(model="gpt-6-luna", reasoning_effort="none", tools=t)\n',
    );
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("We use gpt-4o.\n");
    expect(await readFile(join(root, "tests", "test_bot.py"), "utf8")).toBe('MODEL = "gpt-4o"\n');
  });

  it("scans a single file", async () => {
    root = await mkdtemp(join(tmpdir(), "llm-retire-scan-"));
    await writeFile(join(root, "bot.py"), 'MODEL = "gpt-4o"\n');
    const result = await scanDirectory(join(root, "bot.py"), { providers: ["openai"] });
    expect(result.findings.map((f) => `${f.file}:${f.line}:${f.rule}`)).toEqual(["bot.py:1:shutdown"]);
  });

  it("warns about a call whose model default lives in another file", async () => {
    root = await mkdtemp(join(tmpdir(), "llm-retire-scan-"));
    await writeFile(join(root, "config.js"), 'export const config = {\n  openaiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",\n};\n');
    await writeFile(join(root, ".env.example"), "OPENAI_MODEL=gpt-4o-mini\n");
    await writeFile(join(root, "chat.js"), [
      "const body = { model: config.openaiModel, messages, tools };",
      "const r = await client.chat.completions.create({ ...body, stream: true });",
      "const s = await client.chat.completions.create({ model: process.env.OPENAI_MODEL, messages, temperature: 0 });",
      "",
    ].join("\n"));

    const { findings } = await scanDirectory(root, { providers: ["openai"] });
    const calls = findings.filter((f) => f.file === "chat.js");

    expect(calls.map((f) => `${f.line}:${f.rule}:${f.severity}`)).toEqual([
      "2:tools-effort:warn",
      "3:sampling-effort:warn",
    ]);
    expect(calls[0]?.message).toContain("config.js:2 sets openaiModel to gpt-4.1-mini");
    expect(calls[1]?.message).toContain(".env.example:1 sets OPENAI_MODEL to gpt-4o-mini");
  });

  it("scans test files when asked", async () => {
    root = await mkdtemp(join(tmpdir(), "llm-retire-scan-"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "tests", "test_bot.py"), 'MODEL = "gpt-4o"\n');
    expect((await scanDirectory(root, { providers: ["openai"] })).findings).toEqual([]);
    const all = await scanDirectory(root, { providers: ["openai"], includeTests: true });
    expect(all.findings.map((f) => f.rule)).toEqual(["shutdown"]);
  });
});
