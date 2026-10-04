/**
 * Op activities for the change-set document (#3181).
 *
 * A combined run over several members plans each one in its own step, joins
 * the parts with {@link composeChangeSet}, and binds its gate to the
 * document's digest:
 *
 * ```ts
 * phase("Plan", [
 *   terraformPlan({ root: "estate", id: "estate" }),          // a choudoufu member
 *   lifecyclePlanChangeSet({ member: "delivery", env: "prod", cwd: "delivery", id: "delivery" }),
 *   readChangeSetPart({ member: "warden", planner: "warden", file: "warden.plan.json", id: "warden" }),
 *   composeChangeSet({ parts: [estate.out.changeSet, delivery.out.part, warden.out.part], id: "change-set" }),
 * ]),
 * phase("Approve", [gate("approve-run", { plan: stepOutput("change-set", "digest") })]),
 * ```
 *
 * Each activity here only reads: a plan, a file, or the parts it is handed.
 */

import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  composeChangeSet as compose,
  lifecyclePlanPart,
  reconcilePlanPart,
  type ChangeSetDocument,
  type ChangeSetPart,
  type ChangeSetSummary,
} from "../../change-set";
import type { ChangeSet as LifecycleChangeSet } from "../../lifecycle/change-set";
import type { ChangeSet as ReconcileChangeSet } from "../../reconcile";
import { CHANT_VERSION } from "../../cli/version";

const execAsync = promisify(exec);

export interface ComposeChangeSetArgs {
  /** One part per member, usually step outputs: `terraformPlan`'s `changeSet`, the other activities' `part`. */
  parts: ChangeSetPart[];
}

export interface ComposeChangeSetResult {
  document: ChangeSetDocument;
  /** The document's digest. A gate's `plan` binds it. */
  digest: string;
  summary: ChangeSetSummary;
}

/** Join members' parts into one change-set document. Fails when two parts name the same member. */
export async function composeChangeSet(args: ComposeChangeSetArgs): Promise<ComposeChangeSetResult> {
  const parts = args.parts ?? [];
  const missing = parts.findIndex((p) => !p || typeof p !== "object" || !p.member);
  if (missing !== -1) throw new Error(`composeChangeSet: parts[${missing}] is not a change-set part; did the step that plans it run?`);
  const document = compose(parts, { chant: CHANT_VERSION });
  return { document, digest: document.digest, summary: document.summary };
}

export interface LifecyclePlanChangeSetArgs {
  /** The workspace member the plan is of. */
  member: string;
  env: string;
  /** The member's directory. Default: the current directory. */
  cwd?: string;
  /** Pass `--owned`, so owned resources missing from source plan as deletes. */
  owned?: boolean;
}

export interface ChangeSetPartResult {
  part: ChangeSetPart;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `chant lifecycle plan <env> --json` in a chant member's directory, as that member's change-set part. */
export async function lifecyclePlanChangeSet(args: LifecyclePlanChangeSetArgs, signal?: AbortSignal): Promise<ChangeSetPartResult> {
  const { stdout } = await execAsync(`chant lifecycle plan ${shellQuote(args.env)}${args.owned ? " --owned" : ""} --json`, {
    cwd: args.cwd ? resolve(args.cwd) : process.cwd(),
    signal,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { part: lifecyclePlanPart({ member: args.member, plan: JSON.parse(stdout) as LifecycleChangeSet }) };
}

export interface ReadChangeSetPartArgs {
  member: string;
  /** Which planner wrote the file: `chant` (`lifecycle plan --json`) or `warden` (its reconcile change sets). */
  planner: "chant" | "warden";
  /** The plan file, relative to the current directory. */
  file: string;
  /** The lexicon the entries belong to, when the plan does not say. */
  lexicon?: string;
}

/**
 * A plan another step or job wrote to a file, as a member's part. A warden
 * plan is the reconcile `ChangeSet` (`@intentius/chant/reconcile`), or an
 * array of them, one per cycle and org.
 */
export async function readChangeSetPart(args: ReadChangeSetPartArgs): Promise<ChangeSetPartResult> {
  const plan: unknown = JSON.parse(readFileSync(resolve(args.file), "utf-8"));
  const lexicon = args.lexicon !== undefined ? { lexicon: args.lexicon } : {};
  switch (args.planner) {
    case "chant":
      return { part: lifecyclePlanPart({ member: args.member, plan: plan as LifecycleChangeSet, ...lexicon }) };
    case "warden":
      return { part: reconcilePlanPart({ member: args.member, plan: plan as ReconcileChangeSet | ReconcileChangeSet[], ...lexicon }) };
    default:
      throw new Error(`readChangeSetPart: no adapter for planner ${String(args.planner)}; terraform-family plans come from terraformPlan's changeSet`);
  }
}
