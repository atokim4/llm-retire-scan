#!/usr/bin/env node
import { parseArgs } from "node:util";

import { describeSampling } from "./anthropic/scan.ts";
import { describeOpenAIModel } from "./openai/describe.ts";
import { PROVIDERS, scanDirectory } from "./scan.ts";
import type { Finding, Provider } from "./types.ts";

const USAGE = `Usage: node src/cli.ts [dir or file] [--provider openai,anthropic] [--fix] [--include-tests] [--json] [--fail-on error|warn|never]
       node src/cli.ts --model <id> [--model <id> ...]

Scans a directory (default: .) or one file for OpenAI and Claude model IDs that are shut down or shutting
down, and for the request settings that break on their replacements (tools and
temperature on a reasoning model, max_tokens, sampling on Claude 4.7+).
--fix swaps gpt-4o / gpt-4o-mini / gpt-4.1 / gpt-4.1-mini for gpt-6-luna and adds
reasoning_effort "none" where a call sends tools or sampling settings.
Test, fixture and mock files are skipped unless --include-tests is given.
Exit code: 1 when a finding at or above --fail-on (default: error) is left, 2 on bad usage.`;

function toMarkdown(findings: Finding[]): string {
  if (findings.length === 0) return "No findings.";
  const rows = findings.map(
    (f) =>
      `| ${f.severity} | ${f.provider}/${f.rule}${f.fixable ? " (fix)" : ""} | ${f.file}:${f.line} | ` +
      `${f.message.replaceAll("|", "\\|")} |`,
  );
  return ["| severity | rule | where | what |", "|---|---|---|---|", ...rows].join("\n");
}

function parseProviders(value: string): Provider[] | null {
  const list = value.split(",").map((p) => p.trim()).filter(Boolean);
  return list.length > 0 && list.every((p) => (PROVIDERS as string[]).includes(p)) ? (list as Provider[]) : null;
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        fix: { type: "boolean", default: false },
        "include-tests": { type: "boolean", default: false },
        "fail-on": { type: "string", default: "error" },
        provider: { type: "string", default: PROVIDERS.join(",") },
        model: { type: "string", multiple: true },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.model) {
    for (const id of values.model) {
      console.log(/claude/i.test(id) ? describeSampling(id) : describeOpenAIModel(id));
    }
    return 0;
  }

  const failOn = values["fail-on"];
  if (failOn !== "error" && failOn !== "warn" && failOn !== "never") {
    console.error(`--fail-on must be error, warn or never (got "${failOn}")\n\n${USAGE}`);
    return 2;
  }
  const providers = parseProviders(values.provider);
  if (!providers) {
    console.error(`--provider takes a comma list of: ${PROVIDERS.join(", ")} (got "${values.provider}")\n\n${USAGE}`);
    return 2;
  }
  if (positionals.length > 1) {
    console.error(`Give at most one directory or file.\n\n${USAGE}`);
    return 2;
  }

  const root = positionals[0] ?? ".";
  let findings: Finding[];
  let fixed: string[];
  try {
    ({ findings, fixed } = await scanDirectory(root, {
      providers, fix: values.fix, includeTests: values["include-tests"],
    }));
  } catch (error) {
    console.error(`Cannot scan ${root}: ${(error as Error).message}`);
    return 2;
  }

  // After --fix, the fixable findings are gone from the files; report only what is left.
  const left = values.fix ? findings.filter((f) => !f.fixable) : findings;
  if (values.json) {
    console.log(JSON.stringify(values.fix ? { fixed, findings: left } : findings, null, 2));
  } else {
    if (values.fix) console.log(fixed.length ? `Rewrote ${fixed.length} file(s): ${fixed.join(", ")}\n` : "Nothing to rewrite.\n");
    console.log(toMarkdown(left));
  }

  const failing = left.filter((f) => failOn === "warn" || (failOn === "error" && f.severity === "error"));
  return failing.length > 0 ? 1 : 0;
}

process.exitCode = await main();
