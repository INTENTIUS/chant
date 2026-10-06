/**
 * `promtool` and `amtool` as Op steps (#3369), over the functions in
 * `../../tools.ts`.
 *
 * Those functions report `ran: false` when the binary is missing, so tests
 * and CI can skip them. A step does not: a check that did not run must not
 * read as a check that passed, so a missing binary fails the step, and so
 * does a file the tool rejects, with the tool's output as the message.
 *
 * Paths are relative to the working directory. `promtoolTestRules` writes
 * the rule file as `rules.yml` beside each test file, so a test file's
 * `rule_files:` names `rules.yml`; the tests `sloRuleTests()` generates
 * from `Slo` declarations do.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nonRetryableFailure } from "@intentius/chant/op";
import { defaultExec, type ExecRunner } from "@intentius/chant-lexicon-otel/op/activities/exec";
import {
  amtoolCheckConfig as amtoolCheckConfigText,
  promtoolCheckRules as promtoolCheckRulesText,
  promtoolTestRules as promtoolTestRulesText,
  type ToolResult,
} from "../../tools";

export interface ToolStepResult {
  /** The files checked. */
  files: string[];
  ok: boolean;
  output: string;
}

export interface PromtoolCheckRulesArgs {
  /** One rule file or several, e.g. `dist/prometheus/rules.yml`. */
  rules: string | string[];
  /** The promtool binary. Default `$PROMTOOL`, else `promtool`. */
  bin?: string;
}

export interface PromtoolTestRulesArgs {
  /** The rule file under test, e.g. `dist/prometheus/rules.yml`. */
  rules: string;
  /** Unit-test files, each naming `rules.yml` in `rule_files:`. */
  tests?: string | string[];
  /** Unit-test documents given inline, such as the ones `sloRuleTests()` generates. */
  testYaml?: string | string[];
  /** The promtool binary. Default `$PROMTOOL`, else `promtool`. */
  bin?: string;
}

export interface AmtoolCheckConfigArgs {
  /** The Alertmanager config, e.g. `dist/prometheus/alertmanager.yml`. */
  config: string;
  /** The amtool binary. Default `$AMTOOL`, else `amtool`. */
  bin?: string;
}

export interface AmtoolRoutesTestArgs {
  /** The Alertmanager config. */
  config: string;
  /** The alert's labels. */
  labels: Record<string, string>;
  /** The receiver, or receivers in order, the labels must route to. */
  expect: string | string[];
  /** The amtool binary. Default `$AMTOOL`, else `amtool`. */
  bin?: string;
  /** Replaces the child process. For tests. */
  _exec?: ExecRunner;
}

export interface AmtoolRoutesTestResult {
  config: string;
  labels: Record<string, string>;
  /** The receivers amtool resolved, in order. */
  receivers: string[];
  ok: boolean;
}

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");

function settle(tool: string, files: string[], r: ToolResult, bin: string): ToolStepResult {
  if (!r.ran) throw new Error(`${bin} is not installed (or does not run): ${tool} did not check ${files.join(", ")}. Install it or set bin.`);
  if (!r.ok) throw nonRetryableFailure(`${tool} rejected ${files.join(", ")}:\n${r.output.trim()}`, "PrometheusToolRejected");
  return { files, ok: true, output: r.output.trim() };
}

const promtoolBin = (bin?: string) => bin ?? process.env.PROMTOOL ?? "promtool";
const amtoolBin = (bin?: string) => bin ?? process.env.AMTOOL ?? "amtool";

/** `promtool check rules` over each rule file. */
export async function promtoolCheckRules(args: PromtoolCheckRulesArgs): Promise<ToolStepResult> {
  const bin = promtoolBin(args.bin);
  const files = list(args.rules);
  if (files.length === 0) throw new Error("promtoolCheckRules: no rule file given");
  const outputs: string[] = [];
  for (const file of files) outputs.push(settle("promtool check rules", [file], promtoolCheckRulesText(read(file), bin), bin).output);
  return { files, ok: true, output: outputs.join("\n") };
}

/** `promtool test rules` over the rule file, once per test file or inline test document. */
export async function promtoolTestRules(args: PromtoolTestRulesArgs): Promise<ToolStepResult & { tests: number }> {
  const bin = promtoolBin(args.bin);
  const rules = read(args.rules);
  const docs: Array<[string, string]> = [
    ...list(args.tests).map((f): [string, string] => [f, read(f)]),
    ...list(args.testYaml).map((y, i): [string, string] => [`testYaml[${i}]`, y]),
  ];
  if (docs.length === 0) throw new Error("promtoolTestRules: give tests or testYaml (or slos to the builder)");
  const outputs: string[] = [];
  for (const [name, yaml] of docs) outputs.push(settle("promtool test rules", [args.rules, name], promtoolTestRulesText(rules, yaml, bin), bin).output);
  return { files: [args.rules, ...list(args.tests)], ok: true, output: outputs.join("\n"), tests: docs.length };
}

/** `amtool check-config` over the Alertmanager config. */
export async function amtoolCheckConfig(args: AmtoolCheckConfigArgs): Promise<ToolStepResult> {
  const bin = amtoolBin(args.bin);
  return settle("amtool check-config", [args.config], amtoolCheckConfigText(read(args.config), bin), bin);
}

/**
 * The receivers amtool printed: its last non-empty line, comma-separated
 * (`oncall` or `oncall,tickets`).
 */
export function parseRoutesOutput(output: string): string[] {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !/^warning/i.test(l));
  const last = lines[lines.length - 1] ?? "";
  return last.split(",").map((s) => s.trim()).filter(Boolean);
}

/** `amtool config routes test`: the labels route to the expected receivers, in order. */
export async function amtoolRoutesTest(args: AmtoolRoutesTestArgs): Promise<AmtoolRoutesTestResult> {
  const exec = args._exec ?? defaultExec;
  const bin = amtoolBin(args.bin);
  const expected = list(args.expect);
  const pairs = Object.entries(args.labels).map(([k, v]) => `${k}=${v}`);
  const r = await exec(bin, ["config", "routes", "test", `--config.file=${resolve(process.cwd(), args.config)}`, ...pairs], { timeoutMs: 30_000 });
  if (r.code === null) throw new Error(`could not run ${bin}: ${r.error ?? "not found"}. Install amtool or set bin.`);
  if (r.code !== 0) throw nonRetryableFailure(`amtool config routes test failed (exit ${r.code}):\n${(r.stdout + r.stderr).trim()}`, "PrometheusToolRejected");
  const receivers = parseRoutesOutput(r.stdout);
  if (receivers.join(",") !== expected.join(",")) {
    throw nonRetryableFailure(
      `${pairs.join(" ")} routes to ${receivers.join(",") || "(none)"} in ${args.config}, expected ${expected.join(",")}`,
      "PrometheusRouteMismatch",
    );
  }
  return { config: args.config, labels: args.labels, receivers, ok: true };
}
