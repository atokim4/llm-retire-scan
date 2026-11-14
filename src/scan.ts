import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { scanAnthropic } from "./anthropic/scan.ts";
import { type Link, type RepoDefaults, collectDefaults, scanOpenAI, settle } from "./openai/scan.ts";
import { scanPerspective } from "./perspective/scan.ts";
import { lineOf } from "./source.ts";
import type { Edit, Finding, Provider } from "./types.ts";

export const PROVIDERS: readonly Provider[] = ["openai", "anthropic", "perspective"];

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".nuxt", "out", "coverage",
  "vendor", "venv", ".venv", "__pycache__", ".tox", ".mypy_cache", "target", "site-packages",
]);

const SKIP_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "uv.lock",
  "poetry.lock", "Pipfile.lock", "Cargo.lock", "composer.lock", "Gemfile.lock", "go.sum",
]);

const MAX_FILE_BYTES = 1_000_000;
/** A line this long means minified build output: its findings point at a bundle, not source. */
const MAX_LINE_LENGTH = 2_000;

export interface FileResult {
  findings: Finding[];
  edits: Edit[];
  /** "<file>:<line>" model defaults in other files that --fix must leave (see OpenAIScan.holds). */
  holds: string[];
  /** Inserts that depend on an ID swap (see `settle`). */
  links: Link[];
}

/**
 * Scans one file's text for the chosen providers. `file` labels findings and picks the language;
 * `today` (YYYY-MM-DD, default: the current UTC date) sets how close each shutdown is.
 */
export function scanText(
  file: string, text: string, providers: readonly Provider[] = PROVIDERS, defaults?: RepoDefaults, today?: string,
): FileResult {
  const result: FileResult = { findings: [], edits: [], holds: [], links: [] };
  if (/\.min\.[cm]?js$/.test(file)) return result;
  if (providers.includes("openai") && !text.split("\n").some((l) => l.length > MAX_LINE_LENGTH)) {
    const openai = scanOpenAI(file, text, defaults, today);
    result.findings.push(...openai.findings);
    result.edits.push(...openai.edits);
    result.holds.push(...openai.holds);
    result.links.push(...openai.links);
  }
  if (providers.includes("anthropic")) result.findings.push(...scanAnthropic(file, text));
  if (providers.includes("perspective")) result.findings.push(...scanPerspective(file, text, today));
  result.findings.sort((a, b) => a.line - b.line);
  return result;
}

async function* walk(dir: string): AsyncGenerator<string> {
  if ((await stat(dir)).isFile()) {
    yield dir;
    return;
  }
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path);
    } else if (entry.isFile() && !SKIP_FILES.has(entry.name)) {
      yield path;
    }
  }
}

export interface ScanOptions {
  providers?: readonly Provider[];
  /** Write the `--fix` edits back to the files. */
  fix?: boolean;
  /** Also scan test files (mocked requests never reach the API, so they are skipped by default). */
  includeTests?: boolean;
  /** YYYY-MM-DD to measure shutdown dates from (default: the current UTC date). */
  today?: string;
}

/** Issue and PR templates ask reporters which model they used: prose, not configuration. */
const ISSUE_TEMPLATES = /^\.github[\\/](?:ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE)/i;
/** Django / Alembic migrations record history: rewriting the model names there changes nothing. */
const MIGRATIONS = /(?:^|[\\/])(?:migrations|alembic[\\/]versions)[\\/][^\\/]+\.py$/;
const TEST_DIR = /(?:^|[\\/])(?:tests?|__tests__|spec|e2e|fixtures?|__mocks__|mocks|cassettes|\.storybook|[\w.-]*(?:visual|e2e|unit|integration)-tests|[\w.]+\.Tests)[\\/]/i;
const TEST_FILE = /(?:^|[\\/])(?:test_[^\\/]*\.py|[^\\/]*_test\.(?:py|go)|[^\\/]*\.(?:test|spec)\.[cm]?[jt]sx?|conftest\.py)$/;

/** Whether a path (relative to the scan root) is a test, fixture or mock file. */
export function isTestPath(file: string): boolean {
  return TEST_DIR.test(file) || TEST_FILE.test(file);
}

export interface DirectoryResult {
  findings: Finding[];
  /** Files `--fix` rewrote, relative to the root. */
  fixed: string[];
}

/** Scans `root` (a directory, or a single file) and every text file under it, skipping dependency, build, lock, test and migration files. */
export async function scanDirectory(root: string, options: ScanOptions = {}): Promise<DirectoryResult> {
  const files: { path: string; file: string; text: string }[] = [];
  const defaults = new Map<string, string>();
  const single = (await stat(root)).isFile();
  for await (const path of walk(root)) {
    const file = single ? basename(path) : relative(root, path);
    if (ISSUE_TEMPLATES.test(file) || MIGRATIONS.test(file) || (!options.includeTests && isTestPath(file))) continue;
    const { size } = await stat(path);
    if (size > MAX_FILE_BYTES) continue;
    const buffer = await readFile(path);
    if (buffer.includes(0)) continue; // binary
    const text = buffer.toString("utf8");
    files.push({ path, file, text });
    collectDefaults(file, text, defaults);
  }

  // Second pass: a call in one file can take its model from a default set in another.
  const scanned = files.map((f) => ({ ...f, ...scanText(f.file, f.text, options.providers, defaults, options.today) }));
  // A default (`OPENAI_MODEL=gpt-5` in .env) read by a call that can't run on the replacement as it is stays.
  const holds = new Set(scanned.flatMap((s) => s.holds));
  const result: DirectoryResult = { findings: [], fixed: [] };
  for (const { path, file, text, findings, edits, links } of scanned) {
    const held = (line: number) => holds.has(`${file}:${line}`);
    for (const f of findings) {
      if (f.fixable && f.rule === "shutdown" && held(f.line)) {
        f.fixable = false;
        f.message += " --fix leaves it: a call that reads this default has to change first (see its finding).";
      }
    }
    const kept = settle(text, edits.filter((e) => !held(lineOf(text, e.start))), findings, links);
    result.findings.push(...findings);
    if (options.fix && kept.length > 0) {
      await writeFile(path, applyEdits(text, kept));
      result.fixed.push(file);
    }
  }
  return result;
}

/** Applies non-overlapping edits; an edit that overlaps an earlier one is dropped. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.start < cursor) continue;
    out += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + text.slice(cursor);
}
