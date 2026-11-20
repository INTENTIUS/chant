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
 * The module imports only node built-ins, so the pull-request loop's bundle
 * carries it (`pr-loop-bundle.test.ts`).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
export type CostEstimateExec = (argv: string[], cwd: string) => { status: number | null; stdout: string; stderr: string };

const defaultExec: CostEstimateExec = (argv, cwd) => {
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${r.error ? r.error.message : ""}` };
};

/** A member to price: its capability's artifact, and whether its plan changes nothing. `plan` fills `{plan}` when given, else the artifact's `planFile`. */
export interface CostRun {
  member: string;
  artifact?: unknown;
  empty: boolean;
  plan?: string;
}

/** Run `settings.command` over each run that changes something (#4545, #5334). A run with no estimate says why. */
export function priceRuns(settings: Pick<CostEstimateSettings, "command" | "format">, runs: readonly CostRun[], cwd: string, exec: CostEstimateExec = defaultExec): MemberCost[] {
  const format = settings.format ?? "infracost";
  const out: MemberCost[] = [];
  for (const run of runs) {
    if (run.empty) continue;
    const planJson = planJsonOf(run.artifact, cwd);
    if (settings.command.some((a) => a.includes("{planJson}")) && !planJson) {
      out.push({ member: run.member, error: "its plan names no plan document to price" });
      continue;
    }
    const plan = run.plan ?? planFileOf(run.artifact, cwd);
    const argv = settings.command.map((a) => a.replaceAll("{target}", run.member).replaceAll("{plan}", plan).replaceAll("{planJson}", planJson ?? ""));
    const r = exec(argv, cwd);
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
