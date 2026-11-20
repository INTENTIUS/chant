/**
 * The cost estimate of a plan (#5334): a command the user names, run once
 * per member over the plan document its capability wrote, read in one of
 * two shapes, and summed. The same record serves the plan note
 * (`PrReport.cost`, `PrPlanNote.cost`), a policy's `input.cost`, and a
 * wave's cost hold (`holds.cost`, `./op/op-waves-capability.ts`).
 *
 * Both engines hand the command the same thing: `terraform-apply`'s plan
 * names its `show -json` as `artifact.planJson`, and `pulumi-up`'s names
 * its preview JSON there (#5341). `{planJson}` in the command is that
 * file, `{target}` the member and `{plan}` the plan file when the step
 * names one. The presets are the terraform lexicon's `terraformCostHold`
 * (infracost) and the pulumi lexicon's `pulumiCostHold` (a command of the
 * user's).
 *
 * The estimate informs and adds approvals; it never removes one. With
 * `approveAbove` set, a plan whose monthly change is over it, or with a
 * member that could not be priced, is `over`, and the pull request's apply
 * then needs an approval of its own digest, as a policy hold asks. Nothing
 * here lets a plan apply without a person. A failed estimate never fails
 * the plan. It is off until `ci.cost` (or `holds.cost`) is set.
 *
 * The command never sees what the plan keeps secret (#5416). Each plan
 * document is copied with its sensitive values replaced (`redactPlanJson`),
 * and `{planJson}` names the copy, which keeps the original's file name. The
 * command runs with the forge tokens left out of its environment
 * (`costEnv`), by name and by value. A product names more to remove with
 * `redactEnv` (variables whose values are secret) and `dropEnv` (variables to
 * leave out), on an op wave's `holds.cost` and the pulumi and terraform
 * presets: names only, so a secret's value never sits in the spec. Both hold for every caller: the plan
 * note, a policy's `input.cost`, an op wave's `holds.cost` and the pulumi
 * cost hold, so a product's `run wave` job needs no hook of its own.
 *
 * A run can have an environment of its own beside the job's (#5433): an op
 * wave's run gets the `env` its product's `runHooks.beforePlan` gave it,
 * where a product puts a value it reads per run, such as a root's secrets.
 * `CostRun.env` carries it, and the names `redactEnv`, `dropEnv` and the
 * forge tokens hold there are redacted and dropped as the job's are. The
 * command still runs with the job's environment, never the run's.
 *
 * The module imports only node built-ins and `./forge-token-vars`'s token names,
 * so the pull-request loop's bundle carries it (`pr-loop-bundle.test.ts`).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FORGE_TOKEN_VARS } from "./forge-token-vars";

/** The estimate shapes the command may print. */
export const COST_ESTIMATE_FORMATS = ["infracost", "chant"] as const;
export type CostEstimateFormat = (typeof COST_ESTIMATE_FORMATS)[number];

/**
 * `ci.cost` in the workspace declaration (#5334), read at base: the same
 * fields as a wave's `holds.cost`, with `approveAbove` optional.
 */
export interface CostEstimateSettings {
  /** Argv, run once per member that changes something, with `{planJson}`, `{target}` and `{plan}` filled in. It prints the estimate on standard output. */
  command: string[];
  /** `infracost`: `infracost breakdown --format json`'s document. `chant`: `{ "monthlyDelta": <number>, "monthlyTotal"?, "pastMonthlyTotal"?, "currency"? }`. Default `infracost`. */
  format?: CostEstimateFormat;
  /** The currency the amounts are in. Default the estimate's, else `USD`. */
  currency?: string;
  /** The monthly change above which the plan needs an approval of its own. Absent: the estimate only informs. */
  approveAbove?: number;
}

/** What is wrong with a `ci.cost` (or `holds.cost`) value, empty when nothing is. `where` names it; `approveAbove` is required when `requireAmount` is set. */
export function costEstimateProblems(where: string, value: unknown, requireAmount = false): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [`\`${where}\` must be { "command": [...], "approveAbove"${requireAmount ? "" : "?"}: <number>, "format"?, "currency"? }`];
  const c = value as Record<string, unknown>;
  const problems: string[] = [];
  if (!Array.isArray(c.command) || c.command.length === 0 || !c.command.every((a) => typeof a === "string" && a !== "")) problems.push(`\`${where}.command\` must be argv, a non-empty list of strings`);
  if ((requireAmount || c.approveAbove !== undefined) && (typeof c.approveAbove !== "number" || !Number.isFinite(c.approveAbove) || c.approveAbove < 0)) problems.push(`\`${where}.approveAbove\` must be a monthly amount of 0 or more`);
  if (c.format !== undefined && !(COST_ESTIMATE_FORMATS as readonly unknown[]).includes(c.format)) problems.push(`\`${where}.format\` must be ${COST_ESTIMATE_FORMATS.join(" or ")}`);
  if (c.currency !== undefined && (typeof c.currency !== "string" || !/^[A-Z]{3}$/.test(c.currency))) problems.push(`\`${where}.currency\` must be a three-letter currency code, such as "USD"`);
  for (const key of Object.keys(c)) if (!["command", "approveAbove", "format", "currency"].includes(key)) problems.push(`\`${where}.${key}\` is not a setting`);
  return problems;
}

/** What one estimate printed: the monthly change, and the totals when it gave them. */
export interface CostFigures {
  monthlyDelta: number;
  /** The monthly cost once the plan applies. */
  monthlyTotal?: number;
  /** The monthly cost before it. */
  pastMonthlyTotal?: number;
  currency?: string;
}

/** One member's estimate, or why it has none. */
export type MemberCost = ({ member: string } & CostFigures) | { member: string; error: string };

/**
 * A plan's cost estimate (#5334): each member that changes something, the
 * sum of their monthly change, and whether it is over `approveAbove`. What
 * the note shows, and what a policy reads as `input.cost`.
 */
export interface CostEstimate {
  /** The command's first word, such as `infracost`. */
  estimator: string;
  format: CostEstimateFormat;
  currency: string;
  /** The monthly change summed over the members priced. */
  monthlyDelta: number;
  /** The totals summed, when every member priced gave them. */
  monthlyTotal?: number;
  pastMonthlyTotal?: number;
  /** Each member priced or not, in plan order. */
  members: MemberCost[];
  /** The members with no estimate, sorted. */
  unestimated: string[];
  /** The setting at base, or null when unset. */
  approveAbove: number | null;
  /** With `approveAbove`: the change is over it, or a member has no estimate, so the plan needs an approval of its own. Always false without it. */
  over: boolean;
}

/** `input.cost`: the plan's (or the wave's) estimate, and with a per-member policy run, that member's own. */
export interface PolicyCost extends CostEstimate {
  /** The member the policy run is over, when it runs per member (a wave's `holds.policy`). */
  member?: MemberCost;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** The figures an estimate gives, in `format`. Throws when it gives no monthly change. */
export function readCostEstimate(format: CostEstimateFormat, stdout: string): CostFigures {
  const doc = JSON.parse(stdout) as Record<string, unknown>;
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error("the estimate is not a JSON object");
  const currency = typeof doc.currency === "string" ? { currency: doc.currency } : {};
  if (format === "chant") {
    const delta = num(doc.monthlyDelta);
    if (delta === undefined) throw new Error("the estimate has no monthlyDelta");
    const total = num(doc.monthlyTotal);
    const past = num(doc.pastMonthlyTotal);
    return { monthlyDelta: delta, ...(total !== undefined ? { monthlyTotal: total } : {}), ...(past !== undefined ? { pastMonthlyTotal: past } : {}), ...currency };
  }
  // infracost breakdown --format json: diffTotalMonthlyCost, else totalMonthlyCost less pastTotalMonthlyCost.
  const diff = num(doc.diffTotalMonthlyCost);
  const total = num(doc.totalMonthlyCost);
  const past = num(doc.pastTotalMonthlyCost);
  const delta = diff ?? (total !== undefined ? total - (past ?? 0) : undefined);
  if (delta === undefined) throw new Error("the infracost document has no diffTotalMonthlyCost or totalMonthlyCost");
  return { monthlyDelta: delta, ...(total !== undefined ? { monthlyTotal: total } : {}), ...(past !== undefined ? { pastMonthlyTotal: past } : {}), ...currency };
}

/** The engine's plan document a capability's artifact names (`artifact.planJson`), when it names one that exists. */
export function planJsonOf(artifact: unknown, cwd: string): string | undefined {
  const p = (artifact as { planJson?: unknown } | undefined)?.planJson;
  if (typeof p !== "string" || p === "") return undefined;
  const path = p.startsWith("/") ? p : join(cwd, p);
  return existsSync(path) ? path : undefined;
}

/** The plan file a capability's artifact names (`planFile`), for `{plan}`. */
function planFileOf(artifact: unknown, cwd: string): string {
  const p = (artifact as { planFile?: unknown } | undefined)?.planFile;
  if (typeof p !== "string" || p === "") return "";
  return p.startsWith("/") ? p : join(cwd, p);
}

/** How the estimate command ran. `status` is null when it did not start. */
export type CostEstimateExec = (argv: string[], cwd: string, env?: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string };

/**
 * What a product names for the cost command to lose, as names only: a
 * secret's value reaches the job through a variable (the environment set's
 * `secrets`, #5348, or a variable the job reads), so the spec holds the
 * variable's name and the value is read from the job's environment when the
 * estimate runs.
 */
export interface CostEnvOptions {
  /** Variables whose values are secret: each value is replaced by `[redacted]` in the plan copy, and the variable is left out of the command's environment, by name and by value. */
  redactEnv?: readonly string[];
  /** Variables left out of the command's environment, by name and by value, beside the forge tokens. A value they hold is replaced by `[redacted]` in the plan copy too. */
  dropEnv?: readonly string[];
}

/**
 * `env` as the estimate command gets it (#5416): less every forge token, by
 * name (`FORGE_TOKEN_VARS`) and by value, so a variable another name holds a
 * token in goes too. Any other variable is kept. With `runEnv`, a run's own
 * environment (#5433), the values it holds under those names go by value too.
 */
export function costEnv(env: NodeJS.ProcessEnv, extra: CostEnvOptions = {}, runEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = new Set<string>([...FORGE_TOKEN_VARS, ...(extra.redactEnv ?? []), ...(extra.dropEnv ?? [])]);
  // #5433: a value a run's own environment holds under one of the names goes too, whichever variable of the job's holds it.
  const held = new Set([...names].flatMap((name) => [env[name] ?? "", runEnv?.[name] ?? ""]).filter((v) => v !== ""));
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (names.has(name)) continue;
    if (value !== undefined && held.has(value)) continue;
    out[name] = value;
  }
  return out;
}

const defaultExec: CostEstimateExec = (argv, cwd, env = costEnv(process.env)) => {
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd, env, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${r.error ? r.error.message : ""}` };
};

/** What stands where a sensitive value was (#5416). */
export const COST_REDACTED = "[redacted]";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/** Replace what `mark` marks `true` in `value`; `mark` mirrors the value's shape, as terraform's `*_sensitive` does. */
function cover(value: unknown, mark: unknown): unknown {
  if (value === undefined) return value;
  if (mark === true) return value === null ? null : COST_REDACTED;
  if (Array.isArray(mark) && Array.isArray(value)) return value.map((v, i) => cover(v, mark[i]));
  if (isObject(mark) && isObject(value)) {
    const out: Json = { ...value };
    for (const k of Object.keys(mark)) if (k in out) out[k] = cover(out[k], mark[k]);
    return out;
  }
  return value;
}

/** Pulumi's secret wrapper: an object holding this key is a secret, and its other keys hold the value or its ciphertext. */
const PULUMI_SECRET_SIG = "4dabf18193072939515e22adb298388d";

/** Walk `plan`, covering each value a plan marks sensitive. */
function coverMarked(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(coverMarked);
  if (!isObject(node)) return node;
  if (PULUMI_SECRET_SIG in node) return COST_REDACTED;
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) out[k] = coverMarked(v);
  // terraform: a change's before/after and a resource's values carry a sibling that marks what is sensitive.
  for (const [value, mark] of [["before", "before_sensitive"], ["after", "after_sensitive"], ["values", "sensitive_values"]] as const) {
    if (value in out && mark in node) out[value] = cover(out[value], node[mark]);
  }
  // terraform: an output marked sensitive.
  if (node.sensitive === true && "value" in out) out.value = cover(out.value, true);
  return out;
}

/** The string leaves of `raw` at each place `safe` holds the redaction mark. */
function coveredStrings(raw: unknown, safe: unknown, out: Set<string>): void {
  if (safe === COST_REDACTED) {
    const leaves = (v: unknown): void => {
      if (typeof v === "string") {
        if (v !== "" && v !== COST_REDACTED) out.add(v);
      } else if (Array.isArray(v)) v.forEach(leaves);
      else if (isObject(v)) Object.values(v).forEach(leaves);
    };
    leaves(raw);
  } else if (Array.isArray(raw) && Array.isArray(safe)) raw.forEach((r, i) => coveredStrings(r, safe[i], out));
  else if (isObject(raw) && isObject(safe)) for (const k of Object.keys(raw)) if (k in safe) coveredStrings(raw[k], safe[k], out);
}

/** `value` with each of `secrets` replaced where a string is one, and cut out of a longer string when it is eight characters or more. */
function scrub(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    if (secrets.includes(value)) return COST_REDACTED;
    let text = value;
    for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join(COST_REDACTED);
    return text;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, secrets)]));
  return value;
}

/**
 * A plan document with every sensitive value replaced by `COST_REDACTED`
 * (#5416). It reads what terraform and OpenTofu mark (`before_sensitive`,
 * `after_sensitive`, `sensitive_values`, a sensitive output) and what Pulumi
 * wraps as a secret, then replaces each value it covered wherever else the
 * document repeats it (a binary does not mark every copy), and the values of
 * `extra`, such as the forge tokens the environment holds. The input is not
 * changed.
 */
export function redactPlanJson(plan: unknown, extra: readonly string[] = []): unknown {
  const marked = coverMarked(plan);
  const found = new Set<string>(extra.filter((v) => v !== ""));
  coveredStrings(plan, marked, found);
  const secrets = [...found].sort((a, b) => b.length - a.length);
  return secrets.length === 0 ? marked : scrub(marked, secrets);
}

/** The values of the forge tokens `env` holds, and of the variables `extra` names, in the job's environment and the run's own (#5433). */
function tokenValues(env: NodeJS.ProcessEnv, extra: CostEnvOptions = {}, runEnv?: NodeJS.ProcessEnv): string[] {
  return [...FORGE_TOKEN_VARS, ...(extra.redactEnv ?? []), ...(extra.dropEnv ?? [])].flatMap((name) => [env[name] ?? "", runEnv?.[name] ?? ""]).filter((v) => v !== "");
}

/** A member to price: its capability's artifact, and whether its plan changes nothing. `plan` fills `{plan}` when given, else the artifact's `planFile`. */
export interface CostRun {
  member: string;
  artifact?: unknown;
  empty: boolean;
  plan?: string;
  /**
   * The run's own environment beside the job's (#5433), such as the `env` a
   * product's `runHooks.beforePlan` gave an op wave's run. The values the
   * forge tokens, `redactEnv` and `dropEnv` hold in it are redacted from the
   * plan copy and dropped from the command's environment. The command does
   * not run with it.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Run `settings.command` over each run that changes something (#4545, #5334).
 * The command reads a redacted copy of the plan document and runs without
 * the forge tokens (#5416), and with `redactEnv` and `dropEnv` also the
 * values and variables a product names, read from the job's environment and
 * the run's own (`CostRun.env`, #5433). A run with no estimate says why.
 */
export function priceRuns(settings: Pick<CostEstimateSettings, "command" | "format"> & CostEnvOptions, runs: readonly CostRun[], cwd: string, exec: CostEstimateExec = defaultExec): MemberCost[] {
  const format = settings.format ?? "infracost";
  const out: MemberCost[] = [];
  let work: string | undefined;
  try {
    for (const run of runs) {
      if (run.empty) continue;
      const original = planJsonOf(run.artifact, cwd);
      if (settings.command.some((a) => a.includes("{planJson}")) && !original) {
        out.push({ member: run.member, error: "its plan names no plan document to price" });
        continue;
      }
      let planJson = original;
      if (original) {
        try {
          const redacted = JSON.stringify(redactPlanJson(JSON.parse(readFileSync(original, "utf-8")) as unknown, tokenValues(process.env, settings, run.env)));
          // One directory per member, so two members' documents of one name never meet, and the copy keeps the name the estimator knows it by.
          work ??= mkdtempSync(join(tmpdir(), "chant-cost-"));
          const dir = mkdtempSync(join(work, "m-"));
          planJson = join(dir, basename(original));
          writeFileSync(planJson, redacted, { mode: 0o600 });
        } catch (err) {
          out.push({ member: run.member, error: `the plan document could not be read to redact it: ${err instanceof Error ? err.message : String(err)}` });
          continue;
        }
      }
      const plan = run.plan ?? planFileOf(run.artifact, cwd);
      const argv = settings.command.map((a) => a.replaceAll("{target}", run.member).replaceAll("{plan}", plan).replaceAll("{planJson}", planJson ?? ""));
      const r = exec(argv, cwd, costEnv(process.env, settings, run.env));
      if (r.status !== 0) {
        out.push({ member: run.member, error: `${argv[0]} ${r.status === null ? "did not run" : `exited ${r.status}`}: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ")}` });
        continue;
      }
      try {
        out.push({ member: run.member, ...readCostEstimate(format, r.stdout) });
      } catch (err) {
        out.push({ member: run.member, error: `the estimate cannot be read: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
  return out;
}

const cents = (n: number): number => Math.round(n * 100) / 100;

/** Sum the members' estimates into one record, against `approveAbove` when the settings give it. */
export function costEstimateOf(settings: CostEstimateSettings, members: readonly MemberCost[]): CostEstimate {
  const priced = members.filter((c): c is Extract<MemberCost, { monthlyDelta: number }> => "monthlyDelta" in c);
  const unestimated = members.filter((c) => "error" in c).map((c) => c.member).sort();
  const monthlyDelta = cents(priced.reduce((sum, c) => sum + c.monthlyDelta, 0));
  const totals = priced.length > 0 && priced.every((c) => c.monthlyTotal !== undefined);
  const pasts = priced.length > 0 && priced.every((c) => c.pastMonthlyTotal !== undefined);
  const approveAbove = settings.approveAbove ?? null;
  return {
    estimator: settings.command[0] ?? "",
    format: settings.format ?? "infracost",
    currency: settings.currency ?? priced.find((c) => c.currency)?.currency ?? "USD",
    monthlyDelta,
    ...(totals ? { monthlyTotal: cents(priced.reduce((s, c) => s + c.monthlyTotal!, 0)) } : {}),
    ...(pasts ? { pastMonthlyTotal: cents(priced.reduce((s, c) => s + c.pastMonthlyTotal!, 0)) } : {}),
    members: [...members],
    unestimated,
    approveAbove,
    over: approveAbove !== null && (monthlyDelta > approveAbove || unestimated.length > 0),
  };
}

/** Price each run and sum them (#5334): {@link priceRuns}, then {@link costEstimateOf}. */
export function estimateCosts(settings: CostEstimateSettings, runs: readonly CostRun[], cwd: string, exec?: CostEstimateExec): CostEstimate {
  return costEstimateOf(settings, priceRuns(settings, runs, cwd, exec));
}

/** `input.cost` for a policy run (#5334): the estimate, and with `member` that member's own figures. */
export function policyCost(estimate: CostEstimate, member?: string): PolicyCost {
  const own = member === undefined ? undefined : estimate.members.find((m) => m.member === member);
  return { ...estimate, members: estimate.members.map((m) => ({ ...m })), unestimated: [...estimate.unestimated], ...(own ? { member: { ...own } } : {}) };
}

/** An amount as the note shows it: `+12.50 USD`. */
export function signedAmount(n: number, currency: string): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return `? ${currency}`;
  return `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(2)} ${currency}`;
}

const code = (s: unknown): string => "`" + String(s).replaceAll("`", "'") + "`";
const plain = (s: unknown): string => String(s).split(/\s+/).join(" ").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "\\|");
const amount = (n: unknown, currency: string): string => (typeof n === "number" && Number.isFinite(n) ? `${n.toFixed(2)} ${currency}` : "");

/**
 * The note's cost section (#5334): the plan's monthly change, a row per
 * member, why a member has no estimate, and, with `approveAbove`, whether
 * the plan needs an approval of its own. `noun` is the product's word for a
 * member, such as `root` or `stack`. A product's plan note hands the record
 * over as data, so each value is checked as it is written.
 */
export function costEstimateLines(estimate: CostEstimate, noun = "member"): string[] {
  const c = plain(estimate.currency ?? "USD");
  const members = (Array.isArray(estimate.members) ? estimate.members : []).filter((m): m is MemberCost => typeof m === "object" && m !== null);
  const total = amount(estimate.monthlyTotal, c);
  const out: string[] = ["", `**Cost (${code(estimate.estimator)}):** ${signedAmount(estimate.monthlyDelta, c)} a month${total ? `, ${total} a month once it applies` : ""}.`];
  if (members.length > 0) {
    out.push("", `| ${noun.charAt(0).toUpperCase()}${noun.slice(1)} | Monthly change | Monthly total |`, "|---|---:|---:|");
    for (const m of members) {
      const mc = typeof (m as { currency?: unknown }).currency === "string" ? plain((m as { currency: string }).currency) : c;
      if ("error" in m) out.push(`| ${code(m.member)} | not estimated | |`);
      else out.push(`| ${code(m.member)} | ${signedAmount(m.monthlyDelta, mc)} | ${amount(m.monthlyTotal, mc)} |`);
    }
  }
  const failed = members.filter((m): m is Extract<MemberCost, { error: string }> => "error" in m);
  if (failed.length > 0) out.push("", ...failed.map((m) => `- ${code(m.member)} was not estimated: ${plain(m.error)}`));
  if (typeof estimate.approveAbove === "number") {
    const limit = amount(estimate.approveAbove, c);
    out.push(
      "",
      estimate.over === true
        ? `The monthly change is over ${limit}${failed.length > 0 ? ", or cannot be known in full" : ""}, so this plan needs an approval of its own digest.`
        : `The monthly change is within ${limit}.`,
    );
  }
  return out;
}
