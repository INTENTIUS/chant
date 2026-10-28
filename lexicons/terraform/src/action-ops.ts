/**
 * A day-2 action (#4653): one Terraform `action` block invoked on its own,
 * under a gated request on the ledger, the way a state-lock release runs
 * (./state-ops.ts).
 *
 * `invokeAction` runs fixed argument lists only. The caller names the root,
 * the binary and the action's address, never extra arguments:
 *
 * 1. `plan -input=false -no-color -invoke=<address> -out=<file>`, then
 *    `show -json <file>`. The address must be one of the plan's
 *    `action_invocations`.
 * 2. `requestGate` under op `tf-action`, subject `<root>:<address>`. The
 *    request's fields bind the address, the commit when given, and a digest
 *    of the plan's `action_invocations`, so a plan whose action input moved
 *    after the approval asks anew. Without an approval that counts (the
 *    requester's own never does) it answers `gated`, exit 3, and runs nothing.
 * 3. With one, `spendGatedRequest`, then `apply <file>`, then
 *    `finishGatedRequest`. The finished line's `result` stays chant's
 *    `applied | failed`; `detail.result` carries `ok` or `failed`, with the
 *    exit code and the last lines of the binary's output.
 *
 * The address is checked before anything runs: `action.<type>.<label>`,
 * after any number of `module.<name>.` steps, each with an optional instance
 * key (`[0]`, `["a"]`). Terraform 1.14.9 parses a module address for
 * `-invoke` (`addrs.ParseTargetAction` reads the module prefix first, and its
 * tests "action invoke in module" and "action invoke in expanded module"
 * expect success), so a templated app's root, which holds only `module
 * "app"`, invokes `module.app.action.<type>.<label>` and needs no root-level
 * action blocks.
 *
 * Only Terraform 1.14 or newer invokes an action. An OpenTofu or choudoufu
 * binary is refused by its engine's name before any exec call (`action-engine`).
 * A `terraform` binary is refused when its version, passed in or read with
 * `version -json`, is older than 1.14.
 *
 * `-invoke` plans in refresh-only mode and refuses `-target`, so the plan
 * changes no resource: the apply runs the action and nothing else.
 *
 * The exec and the ledger are injectable, so a test runs no binary and
 * writes no ledger.
 */
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { Capability, CapabilityPlan } from "@intentius/chant/components/capability";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { readGatedRequests, type GatedRequestRules } from "@intentius/chant/lifecycle/gated-request";
import { terraformChangeSetPart } from "./change-set";
import { DEFAULT_LOCK_TIMEOUT, lockTimeoutArgs } from "./lock-timeout";
import { lastLines, runBinary, type BinaryExec } from "./state/exec";
import { gatedStateOp, StateOpError, StateOpWaitingError, type GatedRequestLedger } from "./state-ops";

/** The op an action's request waits at. */
export const ACTION_OP = "tf-action";

/** The request kind of an action. */
export const ACTION_KIND = "action";

/** The oldest Terraform that invokes an action on its own. */
export const ACTION_MIN_TERRAFORM = "1.14.0";

/** Why an action was refused before it asked for anything. */
export type ActionRefusal = "action-engine" | "action-address" | "unknown-action";

const KEY = String.raw`\[(?:[0-9]+|"[A-Za-z0-9_-]+")\]`;
/** An action address `-invoke` takes: module steps, then `action.<type>.<label>`, instance keys allowed. */
export const ACTION_ADDRESS = new RegExp(String.raw`^(?:module\.[A-Za-z_][A-Za-z0-9_-]*(?:${KEY})?\.)*action\.[a-z0-9_]+\.[A-Za-z_][A-Za-z0-9_-]*(?:${KEY})?$`);

/** The subject an action's request is asked and approved under: `<root>:<address>`. */
export const actionSubject = (root: string, address: string): string => `${root}:${address}`;

export interface InvokeActionInput {
  /** The root's name, as records and messages name it. */
  root: string;
  /** The root's directory. */
  dir: string;
  /** The binary. Default `terraform`. */
  binary?: string;
  /** Its version, when the caller knows it (an image's pin). Absent: read with `version -json` before the plan. */
  version?: string;
  /** The action's address: `action.<type>.<label>` or `module.<name>.action.<type>.<label>`. */
  address: string;
  /** Who asks. */
  requester: string;
  /** Which approvals count. */
  rules: GatedRequestRules;
  /** The commit the root is at, bound by the request. */
  commit?: string;
  /** The saved plan. Default `<dir>/.chant-action.tfplan`. */
  planFile?: string;
  lockTimeout?: string | false;
  env?: NodeJS.ProcessEnv;
  exec?: BinaryExec;
  ledger?: GatedRequestLedger;
  /** The project's directory, where the ledger is. */
  cwd?: string;
  now?: string;
  runId?: string;
  expiry?: string;
  /**
   * Ask anew even when the same request (same subject, requester and
   * fields) applied already. Absent, a call that matches an applied request
   * answers `spent`, so a retried job never runs the action twice.
   */
  anew?: boolean;
}

/** How an action call ended. `exit` is the code a command that ran it exits with. */
export type InvokeActionResult =
  | { outcome: "refused"; code: ActionRefusal; reason: string; exit: number }
  /** No approval counts yet; nothing ran past the plan. `reason` names an approval that stands and does not count. */
  | { outcome: "gated"; digest: string; subject: string; command: string; reason?: string; exit: number }
  /** The request applied already, and a request applies once; nothing ran past the plan. */
  | { outcome: "spent"; digest: string; subject: string; exit: number }
  | { outcome: "ok"; digest: string; subject: string; approvedBy: string; tail: string; recorded: boolean; exit: number }
  | { outcome: "failed"; digest: string; subject: string; approvedBy: string; error: string; tail: string; recorded: boolean; exit: number };

const refused = (code: ActionRefusal, reason: string): InvokeActionResult => ({ outcome: "refused", code, reason, exit: CHANT_EXIT.failed });

/** The engine a binary name runs, when it is one that has no `-invoke`. */
function otherEngine(binary: string): string | undefined {
  const name = basename(binary).toLowerCase().replace(/\.exe$/, "");
  if (name === "tofu" || name === "opentofu" || name.startsWith("tofu-") || name.startsWith("opentofu")) return "OpenTofu";
  if (name.startsWith("choudoufu")) return "choudoufu";
  if (!/^terraform([-_.]?[0-9][0-9.]*)?$/.test(name)) return name;
  return undefined;
}

/** Whether `version` is at least {@link ACTION_MIN_TERRAFORM}. */
export function invokesActions(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 1 || (major === 1 && minor >= 14);
}

/**
 * Refuse a binary that cannot invoke an action, before any exec call when
 * its name or the given version settles it. Undefined: it may run.
 */
export function actionEngineRefusal(root: string, binary: string, version: string | undefined): string | undefined {
  const engine = otherEngine(binary);
  const named = `${binary}${version ? ` ${version}` : ""}`;
  if (engine) return `${root}: an action runs on Terraform ${ACTION_MIN_TERRAFORM.replace(/\.0$/, "")} or newer, and this root runs ${engine} (${named}), which has no action invocation`;
  if (version !== undefined && !invokesActions(version)) return `${root}: an action runs on Terraform ${ACTION_MIN_TERRAFORM.replace(/\.0$/, "")} or newer, and this root runs Terraform ${version} (${binary})`;
  return undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON with every object's keys sorted, so a digest does not follow the emitter's key order. */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v ?? null);

/** The plan's `action_invocations`, as a request binds them: each entry in canonical form, sorted, hashed. */
export function actionInvocationsDigest(plan: unknown): string {
  const list = isObject(plan) && Array.isArray(plan.action_invocations) ? plan.action_invocations.map(canonical).sort() : [];
  return `sha256:${createHash("sha256").update(`[${list.join(",")}]`).digest("hex")}`;
}

/** The addresses the plan's `action_invocations` name. */
export function invokedAddresses(plan: unknown): string[] {
  const list = isObject(plan) && Array.isArray(plan.action_invocations) ? plan.action_invocations : [];
  return list.flatMap((inv) => (isObject(inv) && typeof inv.address === "string" ? [inv.address] : []));
}

async function run(input: InvokeActionInput, binary: string, args: string[], label: string): Promise<{ stdout: string; out: string }> {
  const exec = input.exec ?? runBinary;
  const done = await exec(binary, args, input.dir, input.env ?? process.env);
  if (done.code !== 0) throw new StateOpError(input.root, `${binary} ${label}`, done.code, lastLines(done.out, 10));
  return done;
}

/** An action's plan read back: the saved plan, its JSON, and the request fields it binds. */
export interface ActionPlanRead {
  planFile: string;
  json: unknown;
  fields: Record<string, string>;
}

/**
 * Check the binary and the address, plan the invocation and read it back.
 * A refusal comes back as a result; a binary run that fails throws
 * {@link StateOpError}.
 */
export async function planAction(input: InvokeActionInput): Promise<ActionPlanRead | Extract<InvokeActionResult, { outcome: "refused" }>> {
  const binary = input.binary ?? "terraform";
  const early = actionEngineRefusal(input.root, binary, input.version);
  if (early) return refused("action-engine", early) as Extract<InvokeActionResult, { outcome: "refused" }>;
  if (!ACTION_ADDRESS.test(input.address)) {
    return refused("action-address", `${input.root}: "${input.address}" is not an action address; give action.<type>.<label>, after module.<name>. for an action in a module`) as Extract<InvokeActionResult, { outcome: "refused" }>;
  }
  if (input.version === undefined) {
    const shown = await run(input, binary, ["version", "-json"], "version -json");
    let version = "";
    try {
      const v = JSON.parse(shown.stdout) as { terraform_version?: unknown };
      version = typeof v.terraform_version === "string" ? v.terraform_version : "";
    } catch {
      version = "";
    }
    const late = actionEngineRefusal(input.root, binary, version || "of no known version");
    if (late) return refused("action-engine", late) as Extract<InvokeActionResult, { outcome: "refused" }>;
  }
  const planFile = input.planFile ?? join(input.dir, ".chant-action.tfplan");
  await run(input, binary, ["plan", "-input=false", "-no-color", `-invoke=${input.address}`, `-out=${planFile}`], `plan -invoke=${input.address}`);
  const show = await run(input, binary, ["show", "-json", planFile], "show -json");
  let json: unknown;
  try {
    json = JSON.parse(show.stdout);
  } catch {
    throw new StateOpError(input.root, `${binary} show -json`, 0, `printed no plan: ${lastLines(show.out, 10)}`);
  }
  const invoked = invokedAddresses(json);
  if (!invoked.includes(input.address)) {
    return refused(
      "unknown-action",
      `${input.root}: the plan invokes ${invoked.length > 0 ? invoked.join(", ") : "no action"}, and not ${input.address}; nothing applied`,
    ) as Extract<InvokeActionResult, { outcome: "refused" }>;
  }
  const fields: Record<string, string> = { address: input.address, invocations: actionInvocationsDigest(json), ...(input.commit ? { commit: input.commit } : {}) };
  return { planFile, json, fields };
}

/** The time of the newest request with these fields that applied already, so asking again answers `spent`. */
async function appliedAt(input: InvokeActionInput, subject: string, fields: Record<string, string>): Promise<string | undefined> {
  const read = input.ledger?.readGatedRequests ?? readGatedRequests;
  const all = await read(ACTION_OP, input.cwd ? { cwd: input.cwd } : undefined).catch(() => []);
  const same = JSON.stringify(Object.entries(fields).sort());
  const last = all
    .filter((g) => g.request.kind === ACTION_KIND && g.request.subject === subject && g.request.by === input.requester)
    .filter((g) => JSON.stringify(Object.entries(g.request.fields).sort()) === same)
    .at(-1);
  return last?.applied ? last.request.at : undefined;
}

/**
 * Invoke one action under a gated request: plan it, ask, and once an
 * approval by someone other than the requester counts, spend it, apply the
 * saved plan and record how it ended.
 */
export async function invokeAction(input: InvokeActionInput): Promise<InvokeActionResult> {
  const binary = input.binary ?? "terraform";
  const planned = await planAction(input);
  if ("outcome" in planned) return planned;
  const subject = actionSubject(input.root, input.address);
  const at = input.anew ? undefined : await appliedAt(input, subject, planned.fields);
  let tail = "";
  const result = await gatedStateOp<string>(
    {
      op: ACTION_OP,
      request: { kind: ACTION_KIND, subject, by: input.requester, fields: planned.fields, ...(at ? { at } : {}) },
      rules: input.rules,
      description: `action ${input.address} on ${input.root}, requested by ${input.requester}`,
      ...(input.expiry ? { expiry: input.expiry } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.now ? { now: input.now } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.commit ? { commit: input.commit } : {}),
      ...(input.ledger ? { ledger: input.ledger } : {}),
      failedDetail: (error): Record<string, string | number | boolean> =>
        error instanceof StateOpError ? { result: "failed", exit: error.code, tail: error.tail.slice(-400), address: input.address } : { result: "failed", address: input.address },
    },
    async () => {
      const done = await run(
        input,
        binary,
        ["apply", "-input=false", "-no-color", ...lockTimeoutArgs("apply", input.lockTimeout ?? DEFAULT_LOCK_TIMEOUT, input.env ?? process.env), planned.planFile],
        "apply",
      );
      tail = lastLines(done.out, 10);
      return { output: tail, detail: { result: "ok", exit: 0, tail: tail.slice(-400), address: input.address } };
    },
  );
  switch (result.status) {
    case "waiting":
      return { outcome: "gated", digest: result.digest, subject, command: result.command, exit: CHANT_EXIT.waiting };
    case "refused":
      return { outcome: "gated", digest: result.digest, subject, command: result.command, reason: result.reason, exit: CHANT_EXIT.waiting };
    case "spent":
      return { outcome: "spent", digest: result.digest, subject, exit: CHANT_EXIT.failed };
    case "held":
      // No last check is passed, so nothing holds; kept for the union.
      return { outcome: "gated", digest: result.digest, subject, command: "", reason: result.reason, exit: CHANT_EXIT.waiting };
    case "done":
      return { outcome: "ok", digest: result.digest, subject, approvedBy: result.approvedBy, tail: result.output, recorded: result.recorded, exit: CHANT_EXIT.done };
    case "failed": {
      const e = result.error;
      return {
        outcome: "failed",
        digest: result.digest,
        subject,
        approvedBy: result.approvedBy,
        error: e.message,
        tail: e instanceof StateOpError ? e.tail : tail,
        recorded: result.recorded,
        exit: CHANT_EXIT.failed,
      };
    }
  }
}

// ── capability ──────────────────────────────────────────────────────────────

/** `terraform-action`: invoke one action of a root under a gated request. */
export interface ActionStepInput {
  root: string;
  /** The action's address. */
  address: string;
  /** The project's directory, where the ledger is and roots are found. Default the process's. */
  cwd?: string;
  /** The root's directory. Default `root` under the project. */
  dir?: string;
  binary?: string;
  /** The binary's version, when the step knows it. */
  version?: string;
  /** Who asks. Default the CI actor, else the user. */
  by?: string;
  /** Which approvals count. Default the ledger's. */
  approval?: GatedRequestRules["mode"];
  /** The commit the request binds. Default the CI's commit variable, when set. */
  commit?: string;
  lockTimeout?: string | false;
}

const actorOf = (env: NodeJS.ProcessEnv): string => env.GITHUB_ACTOR || env.GITLAB_USER_LOGIN || env.USER || env.USERNAME || "unknown";

function stepInvoke(input: ActionStepInput): InvokeActionInput {
  const cwd = input.cwd ?? process.cwd();
  const commit = input.commit ?? (process.env.GITHUB_SHA || process.env.CI_COMMIT_SHA || undefined);
  return {
    root: input.root,
    dir: input.dir ?? join(cwd, input.root),
    address: input.address,
    requester: input.by ?? actorOf(process.env),
    rules: { mode: input.approval ?? "ledger" },
    cwd,
    ...(input.binary ? { binary: input.binary } : {}),
    ...(input.version ? { version: input.version } : {}),
    ...(commit ? { commit } : {}),
    ...(input.lockTimeout !== undefined ? { lockTimeout: input.lockTimeout } : {}),
  };
}

export const terraformActionCapability: Capability<ActionStepInput, { root: string; address: string; digest: string }> = {
  kind: "terraform-action",
  rollbackPolicy: "none-by-design",
  targets: { refuse: "an action is invoked by its own address" },
  async plan(_ctx, input): Promise<CapabilityPlan> {
    const planned = await planAction(stepInvoke(input));
    if ("outcome" in planned) throw new Error(planned.reason);
    const part = terraformChangeSetPart({ member: input.root, plan: planned.json });
    return { member: input.root, planDigest: part.member.planDigest ?? "", changeSet: part };
  },
  async run(_ctx, input) {
    const result = await invokeAction(stepInvoke(input));
    switch (result.outcome) {
      case "ok":
        return { root: input.root, address: input.address, digest: result.digest };
      case "gated":
        throw new StateOpWaitingError(ACTION_OP, result.subject, result.digest, result.command);
      case "spent":
        throw new Error(`${ACTION_OP} ${result.subject}: the request ${result.digest} applied already, and a request applies once`);
      case "refused":
        throw new Error(result.reason);
      case "failed":
        throw new Error(result.error);
    }
  },
};
