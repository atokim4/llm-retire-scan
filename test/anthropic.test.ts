import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acceptsCustomSampling } from "../src/anthropic/models.ts";
import { describeSampling, scanAnthropic } from "../src/anthropic/scan.ts";
import { scanDirectory } from "../src/scan.ts";

const scanText = scanAnthropic;

const rules = (file: string, text: string) => scanText(file, text).map((f) => `${f.line}:${f.rule}`);

describe("model IDs", () => {
  it("flags a retiring dated ID and names its replacement", () => {
    const [finding] = scanText("config.py", 'MODEL = "claude-sonnet-4-5-20250929"\n');
    expect(finding).toMatchObject({ line: 1, rule: "deprecated-model", severity: "error" });
    expect(finding?.message).toContain("2026-11-30");
    expect(finding?.message).toContain("claude-sonnet-5-5");
  });

  it("flags retired IDs, aliases included", () => {
    const text = "a = 'claude-3-5-sonnet-latest'\nb = 'claude-sonnet-4-20250514'\nc = 'claude-2.1'\n";
    expect(rules("x.py", text)).toEqual(["1:retired-model", "2:retired-model", "3:retired-model"]);
  });

  it("reads LiteLLM-prefixed IDs and ignores current ones", () => {
    expect(rules("x.env", "MODEL=anthropic/claude-sonnet-4-5\n")).toEqual(["1:deprecated-model"]);
    expect(rules("x.env", "MODEL=claude-sonnet-5-5\nOTHER=claude-opus-4-8\n")).toEqual([]);
  });

  it("skips Bedrock and Vertex IDs, which follow their own schedules", () => {
    const text = 'id = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"\nv = "claude-sonnet-4-5@20250929"\n';
    expect(rules("x.py", text)).toEqual([]);
  });

  it("skips minified lines", () => {
    const bundle = `var m="claude-sonnet-4-5-20250929";${"x".repeat(3000)}\n`;
    expect(rules("bundle.js", bundle)).toEqual([]);
  });
});

describe("code patterns", () => {
  it("flags content[0].text in code that talks to Claude", () => {
    const text = "from anthropic import Anthropic\nreturn response.content[0].text\n";
    expect(rules("client.py", text)).toEqual(["2:first-block"]);
    expect(rules("client.ts", "// claude\nconst t = data.content[0]?.text;\n")).toEqual(["2:first-block"]);
    expect(rules("client.py", "# claude\nt = r['content'][0]['text']\nu = r.content[0]['text']\n"))
      .toEqual(["2:first-block", "3:first-block"]);
  });

  it("flags sampling settings in code that talks to Claude", () => {
    const text = 'import anthropic\nclient.messages.create(model=m, temperature=0.2)\nkw = {"top_p": 1}\n';
    expect(rules("call.py", text)).toEqual(["2:sampling", "3:sampling"]);
    expect(rules("agent.py", '# claude\npayload["temperature"] = self.temperature\n')).toEqual(["2:sampling"]);
  });

  it("flags a manual thinking budget in code that talks to Claude", () => {
    const text = 'import anthropic\nthinking={"type": "enabled", "budget_tokens": 2048}\n';
    expect(rules("call.py", text)).toEqual(["2:manual-thinking"]);
    expect(rules("call.ts", "// claude\nthinking: { type: 'enabled', budgetTokens: 1024 },\n")).toEqual(["2:manual-thinking"]);
    expect(rules("call.py", "# claude\nif budget_tokens == 0:\n    pass\n")).toEqual([]);
    expect(rules("openai.py", "budget_tokens = 2048\n")).toEqual([]);
  });

  it("in a file that also talks to other providers, flags only lines in a Claude block", () => {
    const registry = [
      'gpt5 = LLM(name="gpt-5",',
      "           temperature=None)",
      "",
      'gemini = LLM(name="gemini-2.5-pro",',
      "             temperature=0.7)",
      "",
      'sonnet = LLM(name="claude-sonnet-5-5",',
      "             temperature=0)",
      "",
    ].join("\n");
    expect(rules("llm.py", registry)).toEqual(["8:sampling"]);

    const reader = [
      "if 'gemini' in model:",
      "    llm = ChatGoogleGenerativeAI(model=model,",
      "                                 temperature=t)",
      "    ",
      "elif 'gpt' in model:",
      "    llm = ChatOpenAI(model=model, temperature=t)",
      "",
      "elif 'claude' in model:",
      "    llm = ChatAnthropic(",
      "        temperature=t,",
      "        model=model)",
      "",
    ].join("\n");
    expect(rules("reader.py", reader)).toEqual(["10:sampling"]);
    // Responses output[0].content[0].text in a mixed file is an OpenAI read, not a Claude one.
    expect(rules("mix.py", "import openai, anthropic\n\ntext = r.output[0].content[0].text\n")).toEqual([]);
  });

  it("keeps the file-wide reading in a Claude-only file", () => {
    const text = "import anthropic\n\nparams = dict(\n    temperature=0.3,\n)\n";
    expect(rules("only.py", text)).toEqual(["4:sampling"]);
  });

  it("skips comment lines", () => {
    const text = "// claude\n// set temperature: 1 here\n# content[0].text was the old way\n";
    expect(rules("x.ts", text)).toEqual([]);
  });

  it("leaves code that never mentions Claude, comparisons, and docs alone", () => {
    expect(rules("openai.py", "client.create(temperature=0.2)\nx = r.content[0].text\n")).toEqual([]);
    expect(rules("claude.py", "if temperature == 1:\n    pass\n")).toEqual([]);
    expect(rules("README.md", "Claude: set temperature: 0.2 and read content[0].text\n")).toEqual([]);
  });
});

describe("acceptsCustomSampling", () => {
  it.each([
    ["claude-sonnet-4-5-20250929", true],
    ["claude-sonnet-4-6", true],
    ["claude-opus-4-20250514", true],
    ["claude-3-5-haiku-20241022", true],
    ["openrouter/anthropic/claude-sonnet-4.6", true],
    ["claude-opus-4-7", false],
    ["openrouter/anthropic/claude-opus-4.7", false],
    ["claude-sonnet-5-5", false],
    ["anthropic/claude-haiku-5-5", false],
    ["claude-fable-5-2", false],
    ["claude-mythos-preview", false],
  ])("%s -> %s", (id, expected) => {
    expect(acceptsCustomSampling(id)).toBe(expected);
  });

  it("returns null for strings it can't place", () => {
    expect(acceptsCustomSampling("gpt-4.1")).toBeNull();
    expect(describeSampling("gpt-4.1")).toContain("not a Claude model ID");
    expect(describeSampling("claude-3-haiku-20240307")).toBe(
      "claude-3-haiku-20240307: retired on 2026-04-20; requests fail. Replacement: claude-haiku-5-5",
    );
    expect(describeSampling("claude-sonnet-4-5")).toContain("retires on 2026-11-30");
  });
});

describe("scanDirectory", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("walks the tree, skips dependencies and lock files, and labels paths relative to the root", async () => {
    root = await mkdtemp(join(tmpdir(), "claude-retire-scan-"));
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await writeFile(join(root, "src", "llm.ts"), 'const model = "claude-sonnet-4-5-20250929";\n');
    await writeFile(join(root, "node_modules", "dep", "x.js"), '"claude-3-opus-20240229"\n');
    await writeFile(join(root, "package-lock.json"), '"claude-3-opus-20240229"\n');
    await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));

    const { findings } = await scanDirectory(root, { providers: ["anthropic"] });

    expect(findings.map((f) => `${f.file}:${f.line}:${f.rule}`)).toEqual([
      join("src", "llm.ts") + ":1:deprecated-model",
    ]);
  });
});
