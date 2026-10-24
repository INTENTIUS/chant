/**
 * `chant workspace run` (#2554, #2524 D17, ws-030): Ops that span members.
 *
 * A workspace run names `<member>/<op>` targets, or asks for the dependents
 * of one member with `--dependents-of <member> --op <op>`. It:
 *
 * 1. reads every member's graph under the member's own toolchain, as
 *    `chant workspace graph` does (`readMembers` in `./graph-cli.ts`), and
 *    turns each composed member into a build root for the cross-root mode of
 *    post-synth checks (#1939): its graph nodes, Ops among them, become the
 *    root's entities;
 * 2. runs OPS019 over those roots, so every target names a composed member
 *    and an Op it declares, and runs nothing when one doesn't;
 * 3. orders the targets so a producer runs before the members that link to
 *    it (the declared and inferred member links of the composed graph), and
 *    otherwise keeps the order given;
 * 4. runs each target's `chant run <op>` in the member's directory under the
 *    member's toolchain, one at a time, stopping at the first that does not
 *    pass. Each member run gets the workspace run's id in its environment
 *    (`CHANT_WORKSPACE_RUN`), and its run record cites it;
 * 5. writes the workspace run's record under `_members/_workspace/<env>/`.
 *
 * With `--gate <name>`, member runs that stop at their own gates are
 * gathered into one pending fact of the workspace gate `<name>`; see
 * `./workspace-gates.ts` for when its approval stands in for theirs.
 *
 * `chant run` at a declared root is untouched: it runs the root's own Ops,
 * and Op discovery leaves member directories out (#2527).
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext, ParsedArgs } from "../cli/registry";
import { runCrossRootChecks, type CrossRootInput, type PostSynthDiagnostic } from "../lint/post-synth";
import { formatWorkspaceOpTarget, ops019Check, parseWorkspaceOpTarget, type WorkspaceOpTarget } from "../lint/rules/op/ops019-workspace-op-target";
import type { Declarable } from "../declarable";
import { readBlobFromPath } from "../lifecycle/git";
import { GATES_DIR, latestPendingGate, parseGateLedger } from "../lifecycle/gate-ledger";
import { readRunLedger, DEFAULT_RUN_ENV } from "../lifecycle/run-ledger";
import { WORKSPACE_GATE_ENV, WORKSPACE_RUN_ENV } from "../op/workspace-run-env";
import type { ComposedNode, WorkspaceGraph } from "./compose-graph";
import { readDeclaration, WorkspaceReadError } from "./declaration";
import { loadKindRegistry } from "./kinds";
import { executePlan, planMembers } from "./member-commands";
import { locateWorkspace } from "./which-chant";
import { appendWorkspaceRun, type WorkspaceRunRecord, type WorkspaceRunStep } from "./workspace-ledger";
import { appendWorkspaceGatePending, type WorkspaceGateCover, type WorkspaceGatePending } from "./workspace-gates";

/** `chant run`'s exit code for a run that stopped at an unapproved gate (`GATED_EXIT_CODE`). */
const GATED_EXIT = 3;

const USAGE =
  "chant workspace run <member>/<op>... [--env <env>] [--gate <name>] [--dry-run] [--json] | chant workspace run --dependents-of <member> --op <op> [--env <env>] [--gate <name>] [--dry-run] [--json] | chant workspace run approve <gate> [--plan <digest>] [--approver <principal>]";

// ── Roots from the composed graph ────────────────────────────────────────────

/**
 * One build root per composed member (#1939's `CrossRootInput`): the member's
 * graph nodes become its entities, keyed by the member's own ids, with their
 * attributes as `props`. The member was read under its own toolchain, so
 * this process builds nothing. Members that were skipped or failed have no root.
 */
export function crossRootInputs(graph: Pick<WorkspaceGraph, "members" | "nodes">, env?: string): CrossRootInput[] {
  const byMember = new Map<string, ComposedNode[]>();
  for (const n of graph.nodes) {
    if (n.nested !== undefined) continue;
    const list = byMember.get(n.member) ?? [];
    list.push(n);
    byMember.set(n.member, list);
  }
  return graph.members
    .filter((m) => m.status === "composed" && m.kind !== "workspace")
    .map((m) => {
      const entities = new Map<string, Declarable>();
      for (const n of byMember.get(m.name) ?? []) {
        const id = n.id.startsWith(`${m.name}/`) ? n.id.slice(m.name.length + 1) : n.id;
        entities.set(id, { lexicon: n.lexicon, entityType: n.kind, props: n.attrs } as unknown as Declarable);
      }
      return {
        root: m.name,
        dir: m.dir,
        ...(env ? { env } : {}),
        buildResult: { outputs: new Map(), entities, warnings: [], errors: [], sourceFileCount: 0 },
      };
    });
}

// ── Order ────────────────────────────────────────────────────────────────────

/** Producer to consumers, from the composed graph's member links (declared and inferred, any status but invalid). */
export function memberDependents(links: WorkspaceGraph["links"]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const row of links) {
    const r = row as { producer?: unknown; consumer?: unknown; status?: unknown };
    if (typeof r.producer !== "string" || typeof r.consumer !== "string") continue;
    if (r.status === "invalid" || r.producer === r.consumer) continue;
    const set = out.get(r.producer) ?? new Set<string>();
    set.add(r.consumer);
    out.set(r.producer, set);
  }
  return out;
}

/** Every member that links to `member`, directly or through others, nearest first. */
export function dependentsOf(member: string, links: WorkspaceGraph["links"]): string[] {
  const edges = memberDependents(links);
  const seen = new Set<string>([member]);
  const order: string[] = [];
  let frontier = [member];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const m of frontier) {
      for (const c of [...(edges.get(m) ?? [])].sort()) {
        if (seen.has(c)) continue;
        seen.add(c);
        order.push(c);
        next.push(c);
      }
    }
    frontier = next;
  }
  return order;
}

/**
 * Order targets so a producer's targets run before its consumers', keeping
 * the given order otherwise. A cycle among the targets' members keeps the
 * given order for the members in it.
 */
export function orderTargets(targets: readonly WorkspaceOpTarget[], links: WorkspaceGraph["links"]): WorkspaceOpTarget[] {
  const edges = memberDependents(links);
  const members = [...new Set(targets.map((t) => t.member))];
  const reach = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const m = stack.pop()!;
      for (const c of edges.get(m) ?? []) {
        if (c === to) return true;
        if (!seen.has(c)) {
          seen.add(c);
          stack.push(c);
        }
      }
    }
    return false;
  };
  // Kahn's algorithm over the targets' members, choosing the earliest given member each time.
  const before = new Map(members.map((m) => [m, members.filter((o) => o !== m && reach(o, m) && !reach(m, o))]));
  const placed: string[] = [];
  const left = [...members];
  while (left.length > 0) {
    const i = left.findIndex((m) => before.get(m)!.every((o) => placed.includes(o)));
    const pick = left.splice(i < 0 ? 0 : i, 1)[0]!;
    placed.push(pick);
  }
  return placed.flatMap((m) => targets.filter((t) => t.member === m));
}

// ── The run ──────────────────────────────────────────────────────────────────

/** What a member's `chant run` answered. */
export interface MemberOpResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WorkspaceRunQuery {
  cwd: string;
  /** `<member>/<op>` targets. Empty with {@link dependentsOf}. */
  targets: string[];
  /** Run `op` in every member that links to this one, directly or not, and not in the member itself. */
  dependentsOf?: string;
  /** The Op `dependentsOf` runs. */
  op?: string;
  env?: string;
  /** The workspace gate member gates may wait on together. */
  gate?: string;
  dryRun?: boolean;
  /** Extra flags each member's `chant run` gets, such as `--on <lexicon>`. */
  runArgs?: string[];
  /** Overrides, for tests. */
  readGraph?: (cwd: string) => Promise<{ graph: WorkspaceGraph; failed: boolean } | { error: string }>;
  runMember?: (member: { name: string; dir: string }, argv: string[], env: Record<string, string>) => Promise<MemberOpResult>;
  now?: () => string;
  /** Where the member's output goes as each step ends. */
  onOutput?: (target: string, result: MemberOpResult) => void;
}

/** A step a dependents run left out, and why. */
export interface WorkspaceRunSkip {
  member: string;
  reason: string;
}

export type WorkspaceRunOutcome =
  | { kind: "refused"; message: string; findings: PostSynthDiagnostic[] }
  | { kind: "planned"; id: string; targets: string[]; skipped: WorkspaceRunSkip[] }
  | { kind: "ran"; record: WorkspaceRunRecord; skipped: WorkspaceRunSkip[]; pending: WorkspaceGatePending | null; ledgerError: string | null };

async function defaultReadGraph(cwd: string): Promise<{ graph: WorkspaceGraph; failed: boolean } | { error: string }> {
  const { workspaceGraph } = await import("./graph-cli");
  const { doc, failed } = await workspaceGraph({ cwd, onStderr: (t) => process.stderr.write(t) });
  if ("error" in doc) return { error: `${doc.error.code}: ${doc.error.message}` };
  return { graph: doc, failed };
}

/**
 * Run one member's `chant run`, under the member's own toolchain (the one
 * `chant workspace graph` reads it with), from inside its directory.
 */
async function defaultRunMember(cwd: string, member: { name: string; dir: string }, argv: string[], env: Record<string, string>): Promise<MemberOpResult> {
  const located = locateWorkspace(cwd);
  const declaration = readDeclaration(located.tree, "", { rootChant: true });
  const { registry: kinds } = loadKindRegistry(declaration.pins, located.rootOnDisk);
  const plan = planMembers("graph", located.rootOnDisk, { only: [member.name], tree: located.tree, kinds });
  if (plan.groups.length === 0) return { exitCode: 1, stdout: "", stderr: `member ${member.name} has no chant to run it\n` };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const [r] = await executePlan(plan, {} as ParsedArgs, () => argv);
    return r ? { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr } : { exitCode: 1, stdout: "", stderr: `member ${member.name} did not run\n` };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The environment directory a member Op run records under: its `labels.Env`, else `local` (`runEnvOf`). */
function opEnv(graph: WorkspaceGraph, t: WorkspaceOpTarget): string {
  for (const n of graph.nodes) {
    if (n.member !== t.member || n.kind !== "Chant::Op") continue;
    const attrs = n.attrs as { name?: unknown; labels?: { Env?: unknown } };
    if (attrs.name === t.op) return typeof attrs.labels?.Env === "string" ? attrs.labels.Env : DEFAULT_RUN_ENV;
  }
  return DEFAULT_RUN_ENV;
}

/** The member run that cites workspace run `id`, and the gate it stopped at, read from the member's ledgers. */
async function memberRunOf(cwd: string, member: string, op: string, env: string, id: string): Promise<{ run: string | null; gate?: WorkspaceRunStep["gate"] }> {
  const { records } = await readRunLedger(env, op, { cwd, member });
  const record = records.filter((r) => r.workspaceRun?.id === id).at(-1);
  if (!record) return { run: null };
  if (record.status !== "gated" || !record.gate) return { run: record.id };
  const gateOp = record.gate.op ?? op;
  const content = await readBlobFromPath(GATES_DIR, `${gateOp}.jsonl`, { cwd, member });
  const pending = content ? parseGateLedger(content).pending.filter((p) => p.runId === record.id) : [];
  const fact = latestPendingGate(pending, record.gate.name);
  return {
    run: record.id,
    gate: { op: gateOp, name: record.gate.name, planDigest: fact?.planDigest ?? null, environment: fact?.environment ?? null },
  };
}

/** Plan and, unless `dryRun`, run a workspace run. Throws a {@link WorkspaceReadError} when the declaration can't be read. */
export async function workspaceRun(query: WorkspaceRunQuery): Promise<WorkspaceRunOutcome> {
  const now = query.now ?? (() => new Date().toISOString());
  const id = `ws-${randomUUID()}`;

  // Targets, before anything is read.
  let targets: WorkspaceOpTarget[] = [];
  for (const text of query.targets) {
    const t = parseWorkspaceOpTarget(text);
    if (!t) return { kind: "refused", message: `"${text}" is not a <member>/<op> target`, findings: [] };
    targets.push(t);
  }
  if (query.dependentsOf !== undefined && !query.op) return { kind: "refused", message: "--dependents-of needs the Op to run: --op <op>", findings: [] };
  if (query.dependentsOf === undefined && targets.length === 0) return { kind: "refused", message: "name at least one <member>/<op> target, or --dependents-of <member> --op <op>", findings: [] };

  const read = await (query.readGraph ?? defaultReadGraph)(query.cwd);
  if ("error" in read) return { kind: "refused", message: `the workspace graph could not be read: ${read.error}`, findings: [] };
  const { graph } = read;
  const roots = crossRootInputs(graph, query.env);

  const skipped: WorkspaceRunSkip[] = [];
  if (query.dependentsOf !== undefined) {
    const op = query.op!;
    if (!graph.members.some((m) => m.name === query.dependentsOf)) {
      return { kind: "refused", message: `--dependents-of ${query.dependentsOf}: the workspace declares no such member`, findings: [] };
    }
    for (const member of dependentsOf(query.dependentsOf, graph.links)) {
      const root = roots.find((r) => r.root === member);
      const hasOp = root && [...root.buildResult.entities.values()].some((e) => e.entityType === "Chant::Op" && (e as unknown as { props?: { name?: unknown } }).props?.name === op);
      if (hasOp) targets.push({ member, op });
      else skipped.push({ member, reason: root ? `declares no Op named "${op}"` : "is not a composed chant member" });
    }
  }

  // OPS019 over the composed roots: the targets must exist before anything runs.
  const findings = runCrossRootChecks([ops019Check(targets)], roots, query.env ? { env: query.env } : undefined);
  if (findings.some((f) => f.severity === "error")) {
    return { kind: "refused", message: "a target does not name an Op of a composed member", findings };
  }

  targets = orderTargets(targets, graph.links);
  if (query.dryRun) return { kind: "planned", id, targets: targets.map(formatWorkspaceOpTarget), skipped };

  const started = now();
  const steps: WorkspaceRunStep[] = targets.map((t) => ({ target: formatWorkspaceOpTarget(t), member: t.member, op: t.op, status: "not-run", exitCode: null, memberRun: null }));
  const env: Record<string, string> = { [WORKSPACE_RUN_ENV]: id, ...(query.gate ? { [WORKSPACE_GATE_ENV]: query.gate } : {}) };
  const runMember = query.runMember ?? ((m, argv, e) => defaultRunMember(query.cwd, m, argv, e));
  let status: WorkspaceRunRecord["status"] = "ok";
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const step = steps[i]!;
    const member = graph.members.find((m) => m.name === t.member)!;
    const argv = ["run", t.op, ...(query.env ? ["--env", query.env] : []), ...(query.runArgs ?? [])];
    const result = await runMember({ name: member.name, dir: member.dir }, argv, env);
    query.onOutput?.(step.target, result);
    step.exitCode = result.exitCode;
    step.status = result.exitCode === 0 ? "ok" : result.exitCode === GATED_EXIT ? "gated" : "fail";
    try {
      const found = await memberRunOf(query.cwd, t.member, t.op, opEnv(graph, t), id);
      step.memberRun = found.run;
      if (found.gate) step.gate = found.gate;
    } catch {
      // A member whose ledger can't be read still ran; the step keeps no member run id.
    }
    if (step.status === "fail") {
      status = "fail";
      break;
    }
    if (step.status === "gated") {
      status = "gated";
      // With a workspace gate, the other targets still run to their gates, so one approval covers them all.
      if (!query.gate) break;
    }
  }

  const record: WorkspaceRunRecord = {
    version: 1,
    id,
    started,
    ended: now(),
    status,
    env: query.env ?? null,
    gate: query.gate ?? null,
    dependentsOf: query.dependentsOf ?? null,
    steps,
  };

  let pending: WorkspaceGatePending | null = null;
  let ledgerError: string | null = null;
  try {
    const covers: WorkspaceGateCover[] = steps
      .filter((s) => s.status === "gated" && s.gate?.planDigest)
      .map((s) => ({ member: s.member, op: s.gate!.op, gate: s.gate!.name, planDigest: s.gate!.planDigest!, ...(s.gate!.environment ? { environment: s.gate!.environment } : {}) }));
    if (query.gate && covers.length > 0) pending = await appendWorkspaceGatePending(query.cwd, { gate: query.gate, run: id, timestamp: record.ended, covers });
    await appendWorkspaceRun(query.cwd, record);
  } catch (err) {
    ledgerError = err instanceof Error ? err.message : String(err);
  }
  return { kind: "ran", record, skipped, pending, ledgerError };
}

// ── The command ──────────────────────────────────────────────────────────────

function describeFinding(f: PostSynthDiagnostic): string {
  return `${f.checkId}: ${f.message}`;
}

export async function runWorkspaceRun(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const words = args.positionals ?? [];
  // positionals[0] is "run".
  const rest = words[0] === "run" ? words.slice(1) : words;
  if (rest[0] === "approve") return runWorkspaceRunApprove(ctx, rest.slice(1));

  const cwd = resolve(".");
  // The root's chant runs the workspace run (ws-021).
  const { handToRootChant } = await import("./which-chant");
  const handed = await handToRootChant(cwd, undefined);
  if (handed !== undefined) return handed;
  let outcome: WorkspaceRunOutcome;
  try {
    outcome = await workspaceRun({
      cwd,
      targets: rest,
      ...(args.dependentsOf !== undefined ? { dependentsOf: args.dependentsOf } : {}),
      ...(args.op !== undefined ? { op: args.op } : {}),
      ...(args.env !== undefined ? { env: args.env } : {}),
      ...(args.gate !== undefined ? { gate: args.gate } : {}),
      ...(args.dryRun ? { dryRun: true } : {}),
      ...(args.on !== undefined ? { runArgs: ["--on", args.on] } : {}),
      onOutput: args.json
        ? undefined
        : (target, r) => {
            process.stderr.write(`── ${target} (exit ${r.exitCode})\n`);
            if (r.stdout) process.stderr.write(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
            if (r.stderr) process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
          },
    });
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    console.error(formatError({ message: `${err.code}: ${err.describe()}`, hint: USAGE }));
    return 1;
  }

  if (outcome.kind === "refused") {
    if (args.json) console.log(JSON.stringify({ status: "refused", message: outcome.message, findings: outcome.findings }, null, 2));
    console.error(formatError({ message: outcome.message, hint: USAGE }));
    for (const f of outcome.findings) console.error(`  ${describeFinding(f)}`);
    return 1;
  }
  if (outcome.kind === "planned") {
    if (args.json) {
      console.log(JSON.stringify({ status: "planned", targets: outcome.targets, skipped: outcome.skipped }, null, 2));
    } else {
      console.log(`chant workspace run would run, in order:`);
      for (const t of outcome.targets) console.log(`  ${t}`);
      for (const s of outcome.skipped) console.log(`  (skipped ${s.member}: ${s.reason})`);
    }
    return 0;
  }

  const { record, pending, ledgerError, skipped } = outcome;
  if (args.json) {
    console.log(JSON.stringify({ ...record, skipped, pending, ledgerError }, null, 2));
  } else {
    console.log(`workspace run ${record.id}: ${record.status}`);
    for (const s of record.steps) console.log(`  ${s.target.padEnd(32)} ${s.status}${s.memberRun ? `  (run ${s.memberRun})` : ""}${s.gate ? `  gate ${s.gate.name}` : ""}`);
    for (const s of skipped) console.log(`  (skipped ${s.member}: ${s.reason})`);
    if (pending) {
      console.log(`Workspace gate "${pending.gate}" is pending over ${pending.covers.length} member gate(s), digest ${pending.digest}.`);
      console.log(`  Approve: chant workspace run approve ${pending.gate} --plan ${pending.digest}`);
      console.log(`  It stands in only for members that set acceptWorkspaceGates: true at base; the others need their own approval.`);
    }
    if (ledgerError) console.error(formatError({ message: `the workspace run record was not written: ${ledgerError}` }));
  }
  if (record.status === "fail") return 1;
  if (record.status === "gated") return GATED_EXIT;
  return 0;
}

async function runWorkspaceRunApprove(ctx: CommandContext, words: string[]): Promise<number> {
  const gate = words[0];
  if (!gate) {
    console.error(formatError({ message: "chant workspace run approve needs the workspace gate's name", hint: USAGE }));
    return 1;
  }
  const { approveWorkspaceGate } = await import("./workspace-gates");
  const approvedBy = ctx.args.approver ?? ctx.args.actor ?? process.env.GITHUB_ACTOR ?? process.env.GITLAB_USER_LOGIN ?? process.env.USER ?? "unknown";
  try {
    const record = await approveWorkspaceGate(resolve("."), {
      gate,
      ...(ctx.args.plan !== undefined ? { digest: ctx.args.plan } : {}),
      approvedBy,
      timestamp: new Date().toISOString(),
    });
    if (ctx.args.json) console.log(JSON.stringify(record, null, 2));
    else console.log(`Approved workspace gate "${gate}" (${record.digest}) as ${approvedBy}, covering ${record.covers.map((c) => `${c.member}/${c.op}:${c.gate}`).join(", ")}.`);
    return 0;
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err), hint: USAGE }));
    return 1;
  }
}
