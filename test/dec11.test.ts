import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { describeOpenAIModel } from "../src/openai/describe.ts";
import { applyEdits, scanDirectory, scanText } from "../src/scan.ts";

const TODAY = "2026-11-14";
const scan = (file: string, text: string, today = TODAY) => scanText(file, text, ["openai"], undefined, today);
const rules = (file: string, text: string) => scan(file, text).findings.map((f) => `${f.line}:${f.rule}`);
const fixed = (file: string, text: string) => applyEdits(text, scan(file, text).edits);

describe("Dec 11 text models", () => {
  it("maps each family to its own replacement", () => {
    const cases: [string, string][] = [
      ["gpt-5", "gpt-6.1-sol"], ["gpt-5-2025-08-07", "gpt-6.1-sol"],
      ["o3", "gpt-6.1-sol"], ["o3-2025-04-16", "gpt-6.1-sol"],
      ["gpt-5-mini", "gpt-6.1-terra"], ["gpt-5-mini-2025-08-07", "gpt-6.1-terra"],
      ["gpt-5-nano", "gpt-6-luna"], ["gpt-5-nano-2025-08-07", "gpt-6-luna"],
    ];
    for (const [id, target] of cases) {
      const text = `MODEL = "${id}"\n`;
      const [finding] = scan("config.py", text).findings;
      expect(finding).toMatchObject({ rule: "shutdown", severity: "error", fixable: true, urgent: true });
      expect(finding?.message).toContain("2026-12-11 (in 27 days)");
      expect(fixed("config.py", text)).toBe(`MODEL = "${target}"\n`);
    }
  });

  it("does not read newer GPT-5.x models, codex or o3-mini as gpt-5 / o3", () => {
    const text = [
      'A = "gpt-5.2"', 'B = "gpt-5.6-sol"', 'C = "gpt-5.5"', 'D = "gpt-5.4-mini"', 'E = "gpt-5-turbo-ish"',
      'F_MODEL = "o3-mini"', 'G = "gpt-5.1"', 'H = "gpt-5-codex"', 'I = "gpt-6.1-sol"', "",
    ].join("\n");
    const found = scan("m.py", text).findings.map((f) => `${f.line}:${f.rule}:${f.message.split(" ")[0]}`);
    expect(found).toEqual(["6:retired:o3-mini", "7:shutdown:gpt-5.1", "8:retired:gpt-5-codex"]);
    const gpt51 = scan("m.py", 'M = "gpt-5.1"\n').findings[0]!;
    expect(gpt51).toMatchObject({ severity: "warn", urgent: false });
    expect(gpt51.message).toContain("2027-04-01");
    expect(gpt51.message).toContain("gpt-6-sol");
  });

  it("doesn't take o3 out of words, flags or longer tokens", () => {
    expect(rules("x.py", 'FLAGS = "-O3"\nNAME = "o3d"\nS3 = "s3://o3/bucket"\nDOC = "o3 is the default model"\nUSE = "use o3 here"\nLOG = "Order \'o3\' (pending -> paid):"\n')).toEqual([]);
    expect(rules("x.yml", "opt: -O3\nregion: o3-west\n")).toEqual([]);
  });

  it("reads a bare o3 as the model only when it is the whole value on a model line", () => {
    const text = [
      'log.info("Using o3")', 'raise ValueError("o3 failed")', 'print("fallback: o3")', 'label = "o3 model"',
      'pollutant = "o3"', 'OPT_LEVELS = ["o1", "o2", "o3"]', 'REASONING_MODEL = "o3"', "",
    ].join("\n");
    expect(rules("x.py", text)).toEqual(["7:shutdown"]);
    expect(rules("p.yml", "pollutants:\n  - no2\n  - o3\nmodel: o3\n")).toEqual(["4:shutdown"]);
    expect(rules("p.json", '{"pollutant": "o3", "model": "o3"}\n')).toEqual(["1:shutdown"]);
    expect(rules("a.py", 'x = client.chat.completions.create(model="o3", messages=m)\n')).toEqual(["1:shutdown"]);
  });

  it("swaps a plain Chat Completions call to gpt-6.1-sol", () => {
    const text = 'r = client.chat.completions.create(model="o3", messages=m, reasoning_effort="high")\n';
    expect(rules("a.py", text)).toEqual(["1:shutdown"]);
    expect(fixed("a.py", text)).toBe(text.replace('"o3"', '"gpt-6.1-sol"'));
  });

  it("holds the swap when tools go through Chat Completions to a responses-only target", () => {
    const text = 'r = client.chat.completions.create(model="gpt-5", messages=m, tools=tools)\n';
    const { findings, edits } = scan("a.py", text);
    expect(findings.map((f) => `${f.rule}:${f.fixable}`)).toEqual(["shutdown:false", "tools-responses-only:false"]);
    expect(findings[1]?.message).toContain("gpt-6.1-sol takes tool calls only on the Responses API");
    expect(findings[0]?.message).toContain("--fix leaves this call");
    expect(edits).toEqual([]);
    // gpt-5-mini → gpt-6.1-terra: none effort exists there, but tools still need Responses.
    const terra = 'const r = await openai.chat.completions.create({ model: "gpt-5-mini", messages, tools });\n';
    expect(rules("a.ts", terra)).toEqual(["1:shutdown", "1:tools-responses-only"]);
    expect(scan("a.ts", terra).edits).toEqual([]);
  });

  it("keeps the ID when unknown code sends tools or sampling next to it", () => {
    const py = 'agent = Agent(\n    name="slackbot",\n    model="o3-2025-04-16",\n    tools=pxt.tools(search),\n)\n';
    const { findings, edits } = scan("agent.py", py);
    expect(findings).toMatchObject([{ rule: "shutdown", fixable: false }]);
    expect(findings[0]?.message).toContain("goes through code this tool doesn't know");
    expect(edits).toEqual([]);
    const held = [
      'MODEL = "gpt-5"\na = Agent(model=MODEL, tools=[search])\n',
      'a = Agent(role="r", llm=LLM(model="gpt-5"), tools=[search])\n',
      'a = Agent("openai/gpt-5", tools=[t])\n',
      'a = Agent(model="gpt-5-nano", tools=[search])\n',
      'a = Agent(model="gpt-5", temperature=0.2)\n',
      'CONFIG = {"model": "gpt-4o-mini", "temperature": 0.7}\n',
    ];
    for (const text of held) expect(scan("a.py", text).edits, text).toEqual([]);
    expect(scan("a.ts", 'const a = createAgent({ llm: { model: "gpt-5" }, tools });\n').edits).toEqual([]);
    // Without tools or sampling next to it, the swap stays.
    expect(scan("a.py", 'a = Agent(model="gpt-5", name="x")\n').edits).toHaveLength(1);
  });

  it("keeps tools on Responses calls swappable", () => {
    const text = 'r = client.responses.create(model="gpt-5", input=q, tools=tools)\n';
    expect(rules("a.py", text)).toEqual(["1:shutdown"]);
    expect(fixed("a.py", text)).toContain('model="gpt-6.1-sol"');
  });

  it("adds effort none for gpt-5-nano tools on Chat Completions (gpt-6-luna allows it)", () => {
    const text = 'r = client.chat.completions.create(model="gpt-5-nano", messages=m, tools=t)\n';
    expect(rules("a.py", text)).toEqual(["1:shutdown", "1:tools-effort"]);
    expect(fixed("a.py", text)).toBe(
      'r = client.chat.completions.create(model="gpt-6-luna", reasoning_effort="none", messages=m, tools=t)\n');
  });

  it("flags minimal effort, which no GPT-6 replacement takes", () => {
    const py = 'r = client.chat.completions.create(model="gpt-5-mini", messages=m, reasoning_effort="minimal")\n';
    const { findings, edits } = scan("a.py", py);
    expect(findings.map((f) => f.rule)).toEqual(["shutdown", "effort-value"]);
    expect(findings[1]?.message).toContain("start with low");
    expect(edits).toEqual([]);
    const js = 'await client.responses.create({ model: "gpt-5", input, reasoning: { effort: "minimal" } });\n';
    expect(rules("a.ts", js)).toEqual(["1:shutdown", "1:effort-value"]);
  });

  it("asks to remove temperature on gpt-6.1-sol (no none effort) instead of adding none", () => {
    const text = 'r = client.chat.completions.create(model="o3", messages=m, temperature=0.2)\n';
    const { findings, edits } = scan("a.py", text);
    expect(findings.map((f) => `${f.rule}:${f.fixable}`)).toEqual(["shutdown:false", "sampling-effort:false"]);
    expect(findings[1]?.message).toContain("remove them");
    expect(edits).toEqual([]);
  });

  it("adds none for temperature on gpt-6.1-terra, which takes none", () => {
    const text = 'r = client.chat.completions.create(model="gpt-5-mini", messages=m, temperature=0)\n';
    expect(fixed("a.py", text)).toBe(
      'r = client.chat.completions.create(model="gpt-6.1-terra", reasoning_effort="none", messages=m, temperature=0)\n');
  });

  it("doesn't warn about the default effort when the old model already reasoned", () => {
    expect(rules("a.py", 'r = client.chat.completions.create(model="gpt-5", messages=m)\n')).toEqual(["1:shutdown"]);
  });

  it("follows a gpt-5 default from another assignment in the file", () => {
    const text = 'MODEL = "gpt-5-mini"\nr = client.chat.completions.create(model=MODEL, messages=m, tools=t)\n';
    expect(rules("a.py", text)).toEqual(["1:shutdown", "2:tools-responses-only"]);
    expect(scan("a.py", text).edits).toEqual([]);
  });
});

describe("pro models", () => {
  it("moves a Responses call to gpt-6.1-sol with reasoning.mode pro", () => {
    const py = 'r = client.responses.create(model="o3-pro", input=q)\n';
    const { findings } = scan("a.py", py);
    expect(findings.map((f) => `${f.rule}:${f.fixable}`)).toEqual(["shutdown:true", "pro-mode:true"]);
    expect(fixed("a.py", py)).toBe('r = client.responses.create(model="gpt-6.1-sol", reasoning={"mode": "pro"}, input=q)\n');
    const ts = 'const r = await client.responses.create({\n  model: "gpt-5-pro",\n  input,\n});\n';
    expect(fixed("a.ts", ts)).toBe('const r = await client.responses.create({\n  model: "gpt-6.1-sol",\n  reasoning: { mode: "pro" },\n  input,\n});\n');
  });

  it("leaves a pro call that already sets reasoning, or runs on Chat Completions", () => {
    const withEffort = 'r = client.responses.create(model="gpt-5-pro", input=q, reasoning={"effort": "high"})\n';
    expect(scan("a.py", withEffort).findings.map((f) => `${f.rule}:${f.fixable}`)).toEqual(["shutdown:false", "pro-mode:false"]);
    expect(scan("a.py", withEffort).edits).toEqual([]);
    const chat = 'r = client.chat.completions.create(model="o3-pro-2025-06-10", messages=m)\n';
    expect(rules("a.py", chat)).toEqual(["1:shutdown", "1:pro-responses-only"]);
    expect(scan("a.py", chat).edits).toEqual([]);
  });

  it("never swaps a pro ID outside a call", () => {
    const { findings, edits } = scan("settings.yml", "model: gpt-5-pro\n");
    expect(findings[0]).toMatchObject({ rule: "shutdown", fixable: false });
    expect(findings[0]?.message).toContain('reasoning.mode "pro"');
    expect(edits).toEqual([]);
  });
});

describe("image models (Dec 1)", () => {
  it("flags every GPT Image 1.5 / 1 mini ID without swapping", () => {
    const text = 'a = "gpt-image-1.5"\nb = "gpt-image-1.5-2025-12-16"\nc = "gpt-image-1-mini"\nd = "chatgpt-image-latest"\n';
    const { findings, edits } = scan("img.py", text);
    expect(findings.map((f) => `${f.rule}:${f.urgent}`)).toEqual(Array(4).fill("image-shutdown:true"));
    expect(findings[0]?.message).toContain("2026-12-01 (in 17 days)");
    expect(findings[0]?.message).toContain("gpt-image-2.6-sunburst or gpt-image-2.6-flare");
    expect(edits).toEqual([]);
  });

  it("knows gpt-image-2 goes later and gpt-image-2.5 / 2.6 stay", () => {
    const found = scan("img.py", 'a = "gpt-image-2"\nb = "gpt-image-2.5-flare"\nc = "gpt-image-2.6-sunburst"\n').findings;
    expect(found.map((f) => `${f.line}:${f.severity}:${f.urgent}`)).toEqual(["1:error:false"]);
    expect(found[0]?.message).toContain("2027-02-10");
  });
});

describe("audio models (2027)", () => {
  it("flags tts-1, gpt-realtime and gpt-audio but not their 2.x / 1.5 replacements", () => {
    const text = [
      'a = "tts-1"', 'b = "tts-1-hd"', 'c = "gpt-realtime"', 'd = "gpt-audio-2025-08-28"', 'e = "gpt-realtime-mini"',
      'f = "gpt-realtime-2.1"', 'g = "gpt-audio-1.5"', 'h = "gpt-realtime-2.1-mini"', 'i = "whisper-1"', "",
    ].join("\n");
    const found = scan("v.py", text).findings;
    expect(found.map((f) => `${f.line}:${f.rule}`)).toEqual(
      ["1:audio-shutdown", "2:audio-shutdown", "3:audio-shutdown", "4:audio-shutdown", "5:audio-shutdown", "9:audio-shutdown"]);
    expect(found[0]?.message).toContain("2027-01-06");
    expect(found[0]?.message).toContain("gpt-realtime-2.1-mini");
    expect(found[2]?.message).toContain("2027-01-20");
  });
});

describe("date-aware severity", () => {
  it("is urgent within 30 days, an error within 90, a warning further out", () => {
    const at = (today: string) => scan("c.py", 'M = "gpt-4o"\n', today).findings[0]!;
    expect(at("2026-11-14")).toMatchObject({ severity: "error", urgent: false });
    expect(at("2026-12-20")).toMatchObject({ severity: "error", urgent: true });
    expect(at("2027-01-20").message).toContain("6 days ago");
    expect(at("2026-09-01")).toMatchObject({ severity: "warn", urgent: false });
  });
});

describe("--model", () => {
  it("describes the Dec 11 IDs and their replacements", () => {
    expect(describeOpenAIModel("gpt-5", TODAY)).toBe("gpt-5: shuts down on 2026-12-11 (in 27 days); replacement gpt-6.1-sol");
    expect(describeOpenAIModel("o3-pro", TODAY)).toContain('reasoning.mode "pro", Responses API only');
    expect(describeOpenAIModel("gpt-6.1-sol", TODAY)).toContain('no "none" effort');
    expect(describeOpenAIModel("gpt-6.1-terra", TODAY)).toContain("tool calling needs the Responses API");
  });
});

describe("defaults in another file", () => {
  it("keeps --fix off a .env default when a call reading it sends tools on Chat Completions", async () => {
    const root = await mkdtemp(join(tmpdir(), "od11-"));
    try {
      await writeFile(join(root, ".env.example"), "OPENAI_MODEL=gpt-5\nIMAGE_MODEL=gpt-image-1.5\n");
      await writeFile(join(root, "bot.py"),
        'r = client.chat.completions.create(model=os.getenv("OPENAI_MODEL"), messages=m, tools=t)\n');
      const { findings, fixed } = await scanDirectory(root, { providers: ["openai"], fix: true, today: TODAY });
      expect(findings.map((f) => `${f.file}:${f.line}:${f.rule}:${f.fixable}`)).toEqual([
        ".env.example:1:shutdown:false", ".env.example:2:image-shutdown:false", "bot.py:1:tools-responses-only:false",
      ]);
      expect(findings[2]?.severity).toBe("warn");
      expect(findings[2]?.message).toContain(".env.example:1 sets OPENAI_MODEL to gpt-5");
      expect(fixed).toEqual([]);
      expect(await readFile(join(root, ".env.example"), "utf8")).toContain("OPENAI_MODEL=gpt-5\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("review regressions", () => {
  it("doesn't add an effort to a call whose shared model constant another call keeps", () => {
    const text = 'MODEL = "gpt-4o"\na = client.chat.completions.create(model=MODEL, messages=m, tools=t)\n' +
      'b = client.chat.completions.create(model=MODEL, messages=m, **opts)\n';
    const { findings, edits } = scan("a.py", text);
    expect(edits).toEqual([]);
    expect(findings.filter((f) => f.fixable)).toEqual([]);
  });

  it("doesn't promise a pro fix when the pro ID comes from a variable", () => {
    const text = 'MODEL = "o3-pro"\nr = client.responses.create(model=MODEL, input="hi")\n';
    const { findings, edits } = scan("a.py", text);
    expect(findings.map((f) => `${f.rule}:${f.fixable}`)).toEqual(["shutdown:false", "pro-mode:false"]);
    expect(edits).toEqual([]);
  });

  it("holds the swap when the effort is set on the options dict after it is built", () => {
    const nano = 'params = {"model": "gpt-5-nano", "messages": m, "tools": t}\nparams["reasoning_effort"] = "minimal"\n' +
      "client.chat.completions.create(**params)\n";
    expect(scan("a.py", nano).edits).toEqual([]);
    const pro = 'p = {"model": "o3-pro", "input": i}\np["reasoning"] = {"effort": "high"}\nclient.responses.create(**p)\n';
    expect(scan("a.py", pro).edits).toEqual([]);
  });

  it("never inserts into an options dict that several calls spread", () => {
    const ts = "const params = { model: \"gpt-4o\", messages, tools };\nawait client.chat.completions.create({ ...params });\n" +
      "await client.chat.completions.create({ ...params, stream: true });\n";
    expect(scan("a.ts", ts).edits).toEqual([]);
    const pro = 'p = {"model": "o3-pro", "input": i}\na = client.responses.create(**p)\nb = client.responses.create(**p)\n';
    expect(scan("a.py", pro).edits).toEqual([]);
    const own = 'params = {"model": "gpt-5-nano", "input": m}\na = client.chat.completions.create(**params, temperature=0)\n' +
      "b = client.responses.create(**params)\n";
    const { findings, edits } = scan("a.py", own);
    expect(edits).toEqual([]);
    expect(findings.filter((f) => f.fixable)).toEqual([]);
  });

  it("makes call-site findings warnings too when the shutdown is more than 90 days out", () => {
    const text = 'r = client.chat.completions.create(model="gpt-5.1", messages=m, temperature=0.2)\n';
    expect(scan("a.py", text).findings.map((f) => `${f.rule}:${f.severity}`)).toEqual(["shutdown:warn", "sampling-effort:warn"]);
  });

  it("holds a default in a folder with a space, and one read by a call with unseen **opts", async () => {
    const root = await mkdtemp(join(tmpdir(), "od11-"));
    try {
      await mkdir(join(root, "my conf"));
      await writeFile(join(root, "my conf", ".env"), "OPENAI_MODEL=gpt-5\nNANO_MODEL=gpt-5-nano\n");
      await writeFile(join(root, "app.py"),
        'a = client.chat.completions.create(model=os.getenv("OPENAI_MODEL"), messages=m, temperature=0.2)\n' +
        'b = client.chat.completions.create(model=os.getenv("NANO_MODEL"), messages=m, **opts)\n');
      const { fixed: rewritten } = await scanDirectory(root, { providers: ["openai"], fix: true, today: TODAY });
      expect(rewritten).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("second review regressions", () => {
  it("drops an effort insert when the ID swap it needs is silenced by an ignore comment", () => {
    const text = 'MODEL = "gpt-5-mini"  # llm-retire-scan: ignore\nclient.chat.completions.create(model=MODEL, messages=m, temperature=0)\n';
    const { findings, edits } = scan("a.py", text);
    expect(edits).toEqual([]);
    expect(findings.filter((f) => f.fixable)).toEqual([]);
  });

  it("holds every definition of a default and drops inserts that depended on a held swap", async () => {
    const root = await mkdtemp(join(tmpdir(), "od11-"));
    try {
      await writeFile(join(root, "a.py"), 'r = client.chat.completions.create(model=CHAT_MODEL, messages=m, tools=t)\n');
      await writeFile(join(root, "b.py"), 'CHAT_MODEL = "gpt-5-mini"\nr = client.chat.completions.create(model=CHAT_MODEL, messages=m, temperature=0)\n');
      await writeFile(join(root, "config.py"), 'CHAT_MODEL = "gpt-5-mini"\n');
      const { fixed: rewritten, findings } = await scanDirectory(root, { providers: ["openai"], fix: true, today: TODAY });
      expect(rewritten).toEqual([]);
      expect(findings.filter((f) => f.fixable)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a pro dict shared with a Chat Completions call, and a pro ID in a getenv default stays honest", () => {
    const shared = 'params = {"model": "o3-pro", "input": q}\na = client.responses.create(**params)\nb = client.chat.completions.create(**params)\n';
    expect(scan("a.py", shared).edits).toEqual([]);
    const env = 'r = client.responses.create(model=os.getenv("MODEL", "o3-pro"), input=q)\n';
    const { findings, edits } = scan("a.py", env);
    expect(edits).toEqual([]);
    expect(findings.filter((f) => f.fixable)).toEqual([]);
  });

  it("holds a dict shared by a chat call and a Responses call that need different inserts", () => {
    const text = 'params = {"model": "gpt-5-mini", "temperature": 0}\na = client.chat.completions.create(**params, messages=m)\n' +
      "b = client.responses.create(**params, input=q)\n";
    expect(scan("a.py", text).edits).toEqual([]);
  });

  it("reads the call's own arguments and spreads next to a spread dict", () => {
    const tools = 'params = {"model": "gpt-5-mini", "messages": m}\nclient.chat.completions.create(**params, tools=tools)\n';
    expect(rules("a.py", tools)).toEqual(["1:shutdown", "2:tools-responses-only"]);
    expect(scan("a.py", tools).edits).toEqual([]);
    const opaque = 'params = {"model": "gpt-5", "messages": m}\nclient.chat.completions.create(**params, **overrides)\n';
    expect(scan("a.py", opaque).edits).toEqual([]);
  });

  it("treats later effort assignments and update / Object.assign as unknown settings", () => {
    const cases = [
      'params = {"model": "gpt-5", "messages": m, "reasoning_effort": "low"}\nif fast:\n    params["reasoning_effort"] = "minimal"\nclient.chat.completions.create(**params)\n',
      'params = {"model": "gpt-5", "messages": m}\nparams.update(temperature=0.2)\nclient.chat.completions.create(**params)\n',
    ];
    for (const text of cases) expect(scan("a.py", text).edits, text).toEqual([]);
    const js = 'const params = { model: "gpt-5", messages };\nObject.assign(params, { tools });\nawait client.chat.completions.create(params);\n';
    expect(scan("a.ts", js).edits).toEqual([]);
  });

  it("finds bare o3 in defaults, CLI args and config values, but not in reason codes", () => {
    const found = [
      'MODEL = os.getenv("MODEL", "o3")', 'model: str = Field(default="o3")', 'parser.add_argument("--model", default="o3")',
      'SUPPORTED_MODELS = ["o3", "gpt-5"]', 'REASON_CODE = "o1"', 'x = MODELS.get(name, "o3")', "",
    ].join("\n");
    expect(scan("a.py", found).findings.map((f) => `${f.line}:${f.message.split(" ")[0]}`))
      .toEqual(["1:o3", "2:o3", "3:o3", "4:o3", "4:gpt-5", "6:o3"]);
    expect(rules("c.yml", 'args: ["--model", "o3"]\nwith: { model: o3 }\nreason: o1\n')).toEqual(["1:shutdown", "2:shutdown"]);
    expect(rules("c.ini", "model = o3 ; reasoning\n")).toEqual(["1:shutdown"]);
    expect(rules("a.ts", 'export const LONG_REASONING_MODEL =\n  "o3";\n')).toEqual(["2:shutdown"]);
  });

  it("reads the openai: prefix (pydantic-ai, LangChain init_chat_model) but never swaps it", () => {
    const text = 'agent = Agent("openai:gpt-5", tools=[t])\nllm = init_chat_model("openai:gpt-5-mini")\n';
    const { findings } = scan("a.py", text);
    expect(findings.map((f) => `${f.line}:${f.fixable}`)).toEqual(["1:false", "2:false"]);
    expect(findings[1]?.message).toContain("pydantic-ai / LangChain model string");
    expect(scan("a.py", text).edits).toEqual([]);
    // The comment on the line above doesn't make a list item a model setting.
    expect(rules("p.py", 'pollutants = [\n    "pm25",  # model input\n    "o3",\n]\n')).toEqual([]);
  });
});

describe("third review regressions", () => {
  it("keeps the swap off a constant when the call reading it is ignored", () => {
    const text = 'MODEL = "gpt-5-nano"\nr = client.chat.completions.create(model=MODEL, messages=m, temperature=0)  # llm-retire-scan: ignore\n';
    expect(scan("a.py", text).edits).toEqual([]);
  });

  it("leaves a model argument that picks between two retiring IDs", () => {
    const text = 'r = client.chat.completions.create(model="gpt-5-nano" if fast else "gpt-5", messages=m, temperature=0)\n';
    const { findings, edits } = scan("a.py", text);
    expect(edits).toEqual([]);
    expect(findings.map((f) => f.rule)).toContain("model-varies");
  });

  it("holds every definition when a repo default is set to IDs with different replacements", async () => {
    const root = await mkdtemp(join(tmpdir(), "od11-"));
    try {
      await writeFile(join(root, "a_settings.py"), 'DEFAULT_MODEL = "gpt-5-nano"\n');
      await writeFile(join(root, "b_app.py"),
        'r = client.chat.completions.create(model=DEFAULT_MODEL, messages=m, tools=t, reasoning_effort="none")\n');
      await writeFile(join(root, "c_prod.py"), 'DEFAULT_MODEL = "gpt-5"\n');
      const { fixed: rewritten, findings } = await scanDirectory(root, { providers: ["openai"], fix: true, today: TODAY });
      expect(rewritten).toEqual([]);
      expect(findings.map((f) => `${f.file}:${f.rule}`)).toContain("b_app.py:model-varies");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
