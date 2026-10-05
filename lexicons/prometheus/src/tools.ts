/**
 * `promtool check rules`, `promtool check config` and `amtool check-config`, when they are installed.
 *
 * The lexicon's own checks cover structure, references and PromQL syntax.
 * The upstream tools add what only Prometheus and Alertmanager know (PromQL
 * types, template parsing in annotations, every receiver field). They are
 * not bundled and not run by `chant build`, so a build gives the same answer
 * everywhere; tests, e2e runs and CI jobs call these helpers, which report
 * `ran: false` when the binary isn't on PATH instead of failing.
 */

import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

export interface ToolResult {
  /** False when the binary isn't installed; `ok` and `output` are then meaningless. */
  ran: boolean;
  ok: boolean;
  /** Combined stdout and stderr. */
  output: string;
}

/** True when `bin` is on PATH (or is a path that runs). */
export function hasTool(bin: string): boolean {
  const r = spawnSync(bin, ["--version"], { encoding: "utf-8" });
  return !r.error && r.status === 0;
}

function runOnText(bin: string, args: (file: string) => string[], filename: string, text: string): ToolResult {
  if (!hasTool(bin)) return { ran: false, ok: false, output: "" };
  const dir = mkdtempSync(join(tmpdir(), "chant-prometheus-"));
  try {
    const file = join(dir, filename);
    writeFileSync(file, text);
    const r = spawnSync(bin, args(file), { encoding: "utf-8" });
    return { ran: true, ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run `promtool check rules` over rule file YAML. `bin` defaults to `promtool` on PATH. */
export function promtoolCheckRules(yaml: string, bin = process.env.PROMTOOL ?? "promtool"): ToolResult {
  return runOnText(bin, (f) => ["check", "rules", f], "rules.yml", yaml);
}

/**
 * Run `promtool check config` over `prometheus.yml` text. The config is written
 * as `prometheus.yml` in a directory of its own, and `files` (path relative to
 * that directory to contents) are written beside it: `check config` also reads
 * the rule files, certificates and credentials files the config names, so a
 * config that names any needs them here. `bin` defaults to `promtool` on PATH.
 */
export function promtoolCheckConfig(
  yaml: string,
  files: Record<string, string> = {},
  bin = process.env.PROMTOOL ?? "promtool",
): ToolResult {
  if (!hasTool(bin)) return { ran: false, ok: false, output: "" };
  const dir = mkdtempSync(join(tmpdir(), "chant-prometheus-"));
  try {
    writeFileSync(join(dir, "prometheus.yml"), yaml);
    for (const [path, content] of Object.entries(files)) {
      const target = join(dir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const r = spawnSync(bin, ["check", "config", "prometheus.yml"], { cwd: dir, encoding: "utf-8" });
    return { ran: true, ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run `promtool test rules` over rule file YAML and a unit-test file for it.
 * The test file's `rule_files:` should name `rules.yml`, which is where the
 * rule file is written beside it. `bin` defaults to `promtool` on PATH.
 */
export function promtoolTestRules(rulesYaml: string, testYaml: string, bin = process.env.PROMTOOL ?? "promtool"): ToolResult {
  if (!hasTool(bin)) return { ran: false, ok: false, output: "" };
  const dir = mkdtempSync(join(tmpdir(), "chant-prometheus-"));
  try {
    writeFileSync(join(dir, "rules.yml"), rulesYaml);
    writeFileSync(join(dir, "rules.test.yml"), testYaml);
    const r = spawnSync(bin, ["test", "rules", "rules.test.yml"], { cwd: dir, encoding: "utf-8" });
    return { ran: true, ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run `amtool check-config` over `alertmanager.yml` text. `bin` defaults to `amtool` on PATH. */
export function amtoolCheckConfig(yaml: string, bin = process.env.AMTOOL ?? "amtool"): ToolResult {
  return runOnText(bin, (f) => ["check-config", f], "alertmanager.yml", yaml);
}
