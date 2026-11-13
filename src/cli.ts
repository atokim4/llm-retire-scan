#!/usr/bin/env node
import { parseArgs } from "node:util";

import { describeSampling } from "./anthropic/scan.ts";
import { describeOpenAIModel } from "./openai/describe.ts";
import { PROVIDERS, scanDirectory } from "./scan.ts";
import type { Finding, Provider } from "./types.ts";

const USAGE = `Usage: node src/cli.ts [dir or file] [--provider openai,anthropic] [--fix] [--include-tests] [--json] [--fail-on error|warn|never] [--today YYYY-MM-DD]
       node src/cli.ts --model <id> [--model <id> ...]

Scans a directory (default: .) or one file for OpenAI and Claude model IDs that are shut down or shutting
down (GPT Image 1.5 on 2026-12-01, GPT-5 and o3 on 2026-12-11, GPT-4o and GPT-4.1 on 2027-01-14, ...), and
for the request settings that break on their replacements (tools on Chat Completions, temperature on a
reasoning model, "minimal" effort, pro mode, max_tokens, sampling on Claude 4.7+).
--fix swaps an ID for its replacement only where the call stays valid (gpt-5 / o3 -> gpt-6.1-sol,
gpt-5-mini -> gpt-6.1-terra, gpt-5-nano and gpt-4o / gpt-4.1 -> gpt-6-luna), adds reasoning_effort "none"
where a call sends tools or sampling settings the target allows only at none, and moves gpt-5-pro / o3-pro
Responses calls to gpt-6.1-sol with reasoning.mode "pro". Everything else is printed as a manual change.
Shutdowns within 30 days (or past) are marked urgent; more than 90 days out they are warnings.
Test, fixture and mock files are skipped unless --include-tests is given.
Exit code: 1 when a finding at or above --fail-on (default: error) is left, 2 on bad usage.`;

function toMarkdown(findings: Finding[]): string {
  if (findings.length === 0) return "No findings.";
  const rows = findings.map(
    (f) =>
      `| ${f.severity}${f.urgent ? " (urgent)" : ""} | ${f.provider}/${f.rule}${f.fixable ? " (fix)" : ""} | ${f.file}:${f.line} | ` +
      `${f.message.replaceAll("|", "\\|")} |`,
  );
  const urgent = findings.filter((f) => f.urgent).length;
  const table = ["| severity | rule | where | what |", "|---|---|---|---|", ...rows].join("\n");
  return urgent ? `${table}\n\n${urgent} urgent: the model is already off or shuts down within 30 days.` : table;
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
        today: { type: "string" },
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
  const today = values.today;
  const realDay = (day: string) => !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
  if (today !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !realDay(today))) {
    console.error(`--today takes a date like 2026-11-14 (got "${today}")\n\n${USAGE}`);
    return 2;
  }
  if (values.model) {
    for (const id of values.model) {
      console.log(/claude/i.test(id) ? describeSampling(id) : describeOpenAIModel(id, today));
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
      providers, fix: values.fix, includeTests: values["include-tests"], today,
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
