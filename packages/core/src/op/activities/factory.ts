/**
 * The factory reference Op's activities (#3406, ws-087): the rules of
 * `../../workspace/factory-rules.ts` run against a workspace, and the two
 * places an orchestrator's execution plugs in, the builder and the check, run
 * as commands in the run's worktree.
 *
 *   factoryPick    which work items are buildable now, in order (the lease claims the first free one)
 *   factoryAsk     the leased item's tier and, for an ask, the understand answer, through `decide`
 *   factoryBuild   the builder hook, in the worktree, unless understand said not to build
 *   factoryCheck   the check hook (or the box's `factory.check`), with its evidence on each criterion
 *   factoryRecord  the outcome: done (amended, proposals added, committed with chant's trailers),
 *                  dropped (committed), redraft or ask (nothing), or not_done (kept by the run)
 *
 * `factoryOp` in `../factory.ts` declares them in that order. An open
 * question in `factoryAsk` stops the run waiting, as `decide` does.
 *
 * Commands run with no shell, split as `box publish` splits a publisher, and
 * asynchronously, so the lease heartbeat keeps running while a builder works.
 */

import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { FactoryClaim, FactoryContext, FactoryItem } from "../../workspace/factory-rules";

/** The run's work lease, as `workLeaseOutput()` hands it to a step. */
export interface FactoryLease {
  item: string;
  holder: string;
  token: string;
  worktree?: string | null;
  branch?: string | null;
}

export interface FactoryPickArgs {
  cwd?: string;
  /** The work kind file, when the declaration names several. */
  kind?: string;
}

export interface FactoryPickResult {
  /** Buildable work items, in record order: the lease claims the first nobody holds. */
  candidates: string[];
  /** Every other item the work kind reads, with why it waits. */
  held: { item: string; hold: string; message: string }[];
  /** One key per candidate, naming the state it was read in, for a steward's ready step. */
  keys: string[];
}

export interface FactoryAskResult {
  item: string;
  ask: boolean;
  tier: string;
  /** The understand point's answer for an ask, or null for an item that isn't one. */
  understand: string | null;
  /** The lease outcome the understand answer leads to, or null when the item is built. */
  outcome: "dropped" | "redraft" | "ask" | null;
}

export interface FactoryBuildResult {
  ran: boolean;
  finished: boolean;
  exitCode: number | null;
  /** Paths the guard put back; the reference Op applies no guard of its own, so this is empty unless a hook reports one. */
  reverted: string[];
  note: string;
}

export interface FactoryCheckResult {
  ran: boolean;
  ok: boolean;
  command: string | null;
  /** The criteria the check's evidence was attached to. */
  evidence: string[];
  log: string | null;
}

export interface FactoryRecordResult {
  outcome: "done" | "not_done" | "dropped" | "redraft" | "ask";
  reason: string | null;
  commit: string | null;
  implementsProposed: { decision: string; paths: string[] }[];
}

// ── shared reads ─────────────────────────────────────────────────────────────

interface WorkRead {
  kindFile: string;
  kindName: string;
  work: NonNullable<import("../../workspace/records").LoadedRecordKind["kind"]["work"]>;
  states: string[];
  stateField: string;
  items: Map<string, FactoryItem & { path: string; acceptance: { id: string; verification: string; met: boolean }[] }>;
  intentDecided: boolean | null;
}

/** The work kind's items and the box's intent, read through the read contract. */
async function readWork(cwd: string, kind?: string): Promise<WorkRead> {
  const { declaredKindFiles, queryDeclaredRecords } = await import("../../workspace/records-cli");
  const { loadRecordKind } = await import("../../workspace/records");
  const files = declaredKindFiles(cwd);
  const set = await queryDeclaredRecords(files, { cwd });
  let found: WorkRead | undefined;
  const decisionStates = new Map<string, { state: string | null; rank: number }>();
  for (const [i, doc] of set.kinds.entries()) {
    if ("error" in doc) continue;
    const loaded = await loadRecordKind(files[i].file, cwd);
    if (!loaded.kind.work) {
      for (const r of doc.records) if (r.id) decisionStates.set(r.id, { state: r.state, rank: r.state ? (loaded.kind.approval?.[r.state] ?? 0) : 0 });
      continue;
    }
    if (found || (kind !== undefined && !files[i].file.endsWith(kind))) continue;
    const work = loaded.kind.work;
    const states = loaded.kind.states ?? [];
    const items: WorkRead["items"] = new Map();
    for (const r of doc.records) {
      if (r.id === null) continue;
      const data = r.data;
      const tier = work.tier ? data?.[work.tier.field] : undefined;
      items.set(r.id, {
        id: r.id,
        path: r.path,
        state: r.state,
        openState: work.open,
        proposedState: states[0] !== undefined && states[0] !== work.open ? states[0] : null,
        ready: r.ready ?? false,
        data,
        tier: typeof tier === "string" ? tier : null,
        contract: r.contract ?? null,
        warnings: r.warnings.map((w) => w.code),
        answers: (r.answers ?? []).map((a) => ({ id: a.id, point: a.point, state: a.state, answer: a.answer })),
        leased: !!r.lease,
        acceptance: (r.acceptance?.criteria ?? []).map((c) => ({ id: c.id, verification: c.verification, met: c.met })),
      });
    }
    found = { kindFile: files[i].file, kindName: loaded.kind.name, work, states, stateField: loaded.kind.stateField ?? "state", items, intentDecided: null };
  }
  if (!found) throw new Error("the factory reads a work kind, and the declaration names none");
  // The box's intent (#2850): while the decision a box block names is not approved, nothing is picked.
  const { readDeclaration } = await import("../../workspace/declaration");
  const { locateWorkspace } = await import("../../workspace/which-chant");
  const intents = readDeclaration(locateWorkspace(cwd).tree).members.map((m) => m.box?.intent).filter((x): x is string => typeof x === "string");
  if (intents.length > 0) found.intentDecided = intents.every((id) => (decisionStates.get(id)?.rank ?? 0) > 0);
  return found;
}

async function gitOut(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  const r = await run(["git", ...args], cwd, {});
  return { ok: r.code === 0, out: r.stdout.trim() };
}

/**
 * A record path from the repository's top: records --json reports paths from
 * the repository root, but outside the process's own directory that report can
 * come back relative to the process instead, so it is resolved and made relative again.
 */
async function fromTop(cwd: string, path: string): Promise<string> {
  if (!path.startsWith("../")) return path;
  const top = (await gitOut(["rev-parse", "--show-toplevel"], cwd)).out;
  try {
    return relative(realpathSync(top), realpathSync(resolve(process.cwd(), path))).split(sep).join("/");
  } catch {
    return path;
  }
}

/** The item as its work branch holds it: the state there, and whether the branch is in HEAD. Null when there is no branch. */
async function branchState(cwd: string, id: string, path: string): Promise<FactoryContext["branch"]> {
  const ref = `refs/heads/chant/work/${id}`;
  if (!(await gitOut(["rev-parse", "--verify", "-q", ref], cwd)).ok) return null;
  const shown = await gitOut(["show", `${ref}:${await fromTop(cwd, path)}`], cwd);
  let state: string | null = null;
  if (shown.ok) {
    const { parseFrontMatter } = await import("../../workspace/records");
    const fm = parseFrontMatter(shown.out);
    if (fm.ok && typeof fm.value.state === "string") state = fm.value.state;
  }
  const applied = (await gitOut(["merge-base", "--is-ancestor", ref, "HEAD"], cwd)).ok;
  return { state, applied };
}

/** The points the workspace declares, by name, or an empty set when it declares none. */
async function declaredPoints(cwd: string): Promise<Set<string>> {
  try {
    const { workspacePoints } = await import("../../workspace/points-cli");
    const doc = await workspacePoints({ cwd });
    return "error" in doc ? new Set() : new Set(doc.points.map((p) => p.name));
  } catch {
    return new Set();
  }
}

/** The question a point would ask about the item as it is now, without writing anything; null when it can't be read. */
async function dryQuestion(cwd: string, point: string, id: string): Promise<{ state: string; answer: string | boolean | null } | null> {
  try {
    const { workspacePoints } = await import("../../workspace/points-cli");
    const doc = await workspacePoints({ cwd });
    if ("error" in doc) return null;
    const p = doc.points.find((x) => x.name === point);
    if (!p) return null;
    const { readInputs } = await import("../decide-read-inputs");
    const { inputs } = await readInputs(p.inputs.map((i) => i.name), { "work-item": id }, cwd);
    const { askPoint } = await import("../../workspace/decide");
    const out = await askPoint({ cwd, point, inputs, subject: id, dryRun: true });
    // Only a question already asked holds an item: one nobody asked yet is what the run asks.
    if ("error" in out || !out.reused) return null;
    return { state: out.question.state, answer: out.question.answer as string | boolean | null };
  } catch {
    return null;
  }
}

async function contextFor(cwd: string, item: FactoryItem & { path: string }, intentDecided: boolean | null, points: Set<string>): Promise<FactoryContext> {
  const { workHistory } = await import("../../workspace/work-cli");
  const h = await workHistory({ id: item.id, cwd });
  const claims: FactoryClaim[] = "error" in h ? [] : h.claims.map((c) => ({ token: c.token, ended: c.ended, outcome: c.release?.outcome ?? null, attempt: c.attempt }));
  const attempts = "error" in h ? { exhausted: false } : { exhausted: h.attempts.exhausted };
  const { isAsk, TIER_POINT, UNDERSTAND_POINT } = await import("../../workspace/factory-rules");
  return {
    intentDecided,
    claims,
    attempts,
    branch: await branchState(cwd, item.id, item.path),
    questions: {
      tier: item.tier === null && points.has(TIER_POINT) ? await dryQuestion(cwd, TIER_POINT, item.id) : null,
      understand: isAsk(item.data) && points.has(UNDERSTAND_POINT) ? await dryQuestion(cwd, UNDERSTAND_POINT, item.id) : null,
    },
  };
}

// ── commands ─────────────────────────────────────────────────────────────────

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run argv in cwd, without a shell, asynchronously. */
function run(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Ran> {
  return new Promise((settle) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", (err) => settle({ code: null, stdout, stderr: `${stderr}${err.message}` }));
    child.on("close", (code) => settle({ code, stdout, stderr }));
  });
}

async function words(command: string): Promise<string[]> {
  const { splitCommand } = await import("../../workspace/box-publish");
  return splitCommand(command);
}

function leaseOf(lease: FactoryLease | undefined, step: string): FactoryLease & { worktree: string } {
  if (!lease || typeof lease.item !== "string" || typeof lease.token !== "string") throw new Error(`${step} runs under the factory Op's work lease: pass workLeaseOutput() as lease`);
  if (!lease.worktree) throw new Error(`${step} needs the run's worktree: the factory Op changes the checkout, so its lease makes one`);
  return lease as FactoryLease & { worktree: string };
}

const today = () => new Date().toISOString().slice(0, 10);

/** Amend `id` in `cwd` through chant, refusing on any write error. */
async function amend(cwd: string, kindFile: string, id: string, fields: Record<string, unknown>): Promise<void> {
  const { amendRecord } = await import("../../workspace/records-write");
  const doc = await amendRecord({ kind: kindFile, id, fields: JSON.stringify(fields), cwd });
  if ("error" in doc) throw new Error(`the factory could not amend ${id}: ${doc.error.code}: ${doc.error.message}`);
}

/** The kind file as seen from the worktree: the same path under the worktree when it sits in the checkout. */
function inWorktree(kindFile: string, checkout: string, worktree: string): string {
  return kindFile.startsWith(`${checkout}/`) ? join(worktree, kindFile.slice(checkout.length + 1)) : kindFile;
}

async function checkoutRoot(cwd: string): Promise<string> {
  return (await gitOut(["rev-parse", "--show-toplevel"], cwd)).out || cwd;
}

/** Commit everything in the worktree with chant's trailers (ws-075). Null when there was nothing to commit. */
async function commitAll(worktree: string, subject: string, item: string, kindName: string, token: string): Promise<string | null> {
  await gitOut(["add", "-A"], worktree);
  if ((await gitOut(["diff", "--cached", "--quiet"], worktree)).ok) return null;
  const { formatChantTrailers } = await import("../../workspace/trailers");
  const trailers = formatChantTrailers({ lease: token, records: [{ kind: kindName, id: item }] });
  const r = await run(["git", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", subject, "-m", trailers.join("\n")], worktree, {});
  if (r.code !== 0) throw new Error(`the factory could not commit ${item}: ${r.stderr.trim()}`);
  return (await gitOut(["rev-parse", "HEAD"], worktree)).out;
}

// ── the activities ───────────────────────────────────────────────────────────

/** Which work items are buildable now (#3406 rule 1). */
export async function factoryPick(args: FactoryPickArgs = {}): Promise<FactoryPickResult> {
  const cwd = args.cwd ?? process.cwd();
  const { pickable, readyKey } = await import("../../workspace/factory-rules");
  const w = await readWork(cwd, args.kind);
  const points = await declaredPoints(cwd);
  const out: FactoryPickResult = { candidates: [], held: [], keys: [] };
  for (const item of w.items.values()) {
    if (item.state !== null && item.state !== item.openState && item.state !== item.proposedState) continue;
    const ctx = await contextFor(cwd, item, w.intentDecided, points);
    const verdict = pickable(item, ctx);
    if (verdict.ok) {
      out.candidates.push(item.id);
      out.keys.push(readyKey(item, ctx, item.data));
    } else out.held.push({ item: item.id, hold: verdict.hold, message: verdict.message });
  }
  return out;
}

export interface FactoryAskArgs {
  lease: FactoryLease;
  cwd?: string;
  kind?: string;
  /** Backends for the points' model deciders, in place of `decide.backends` in chant.config. */
  backends?: import("./decide").DecideArgs["backends"];
}

/** The leased item's tier and understand answer (#3406 rules 2 and 3). An open question stops the run waiting. */
export async function factoryAsk(args: FactoryAskArgs): Promise<FactoryAskResult> {
  const cwd = args.cwd ?? process.cwd();
  if (!args.lease?.item) throw new Error("factoryAsk runs under the factory Op's work lease: pass workLeaseOutput() as lease");
  const id = args.lease.item;
  const { isAsk, understandOutcome, TIER_POINT, UNDERSTAND_POINT } = await import("../../workspace/factory-rules");
  const w = await readWork(cwd, args.kind);
  const item = w.items.get(id);
  if (!item) throw new Error(`no record of the work kind has id ${id}`);
  const points = await declaredPoints(cwd);
  const { decide } = await import("./decide");
  const ask = isAsk(item.data);
  let understand: string | null = null;
  if (ask && points.has(UNDERSTAND_POINT)) understand = String((await decide({ point: UNDERSTAND_POINT, read: { "work-item": id }, subject: id, cwd, ...(args.backends ? { backends: args.backends } : {}) })).answer);
  else if (ask) understand = "proceed";
  const outcome = understandOutcome(understand);
  let tier = item.tier;
  if (tier === null && outcome === null) {
    tier = points.has(TIER_POINT) ? String((await decide({ point: TIER_POINT, read: { "work-item": id }, subject: id, cwd, ...(args.backends ? { backends: args.backends } : {}) })).answer) : (w.work.tier?.tiers[0] ?? "small");
  }
  return { item: id, ask, tier: tier ?? w.work.tier?.tiers[0] ?? "small", understand, outcome };
}

export interface FactoryBuildArgs {
  lease: FactoryLease;
  ask: FactoryAskResult;
  /** The builder hook: a command run in the worktree, with FACTORY_ITEM, FACTORY_TIER, FACTORY_TOKEN, FACTORY_HOLDER, FACTORY_WORKTREE and FACTORY_CONTEXT set. */
  builder: string;
  /** The context hook's output path, or a command that prints the context bundle's path; passed as FACTORY_CONTEXT. */
  context?: string;
  cwd?: string;
}

/** Run the builder hook in the worktree, unless understand said not to build (#3406). */
export async function factoryBuild(args: FactoryBuildArgs): Promise<FactoryBuildResult> {
  const lease = leaseOf(args.lease, "factoryBuild");
  if (args.ask.outcome !== null) return { ran: false, finished: false, exitCode: null, reverted: [], note: `understand answered ${args.ask.understand}: nothing is built` };
  // A kept ask opens before it is built: chant writes the state in the worktree, so it goes with the build.
  const cwd = args.cwd ?? process.cwd();
  const w = await readWork(cwd);
  const item = w.items.get(lease.item);
  if (item && item.proposedState !== null && item.state === item.proposedState) {
    await amend(lease.worktree, inWorktree(w.kindFile, await checkoutRoot(cwd), lease.worktree), lease.item, { [w.stateField]: item.openState });
  }
  const r = await run(await words(args.builder), lease.worktree, {
    FACTORY_ITEM: lease.item,
    FACTORY_TIER: args.ask.tier,
    FACTORY_TOKEN: lease.token,
    FACTORY_HOLDER: lease.holder,
    FACTORY_WORKTREE: lease.worktree,
    ...(args.context ? { FACTORY_CONTEXT: args.context } : {}),
  });
  let reverted: string[] = [];
  try {
    const last = r.stdout.trim().split("\n").pop() ?? "";
    const parsed = JSON.parse(last) as { reverted?: unknown };
    if (Array.isArray(parsed.reverted)) reverted = parsed.reverted.filter((x): x is string => typeof x === "string");
  } catch {
    // The builder printed no JSON line; nothing was reported put back.
  }
  return { ran: true, finished: r.code === 0, exitCode: r.code, reverted, note: r.code === 0 ? "the builder finished" : `the builder exited ${r.code}: ${r.stderr.trim().split("\n").slice(-3).join(" ")}` };
}

export interface FactoryCheckArgs {
  lease: FactoryLease;
  build: FactoryBuildResult;
  /** The check hook: a command run in the worktree, whose exit code is the verdict. The box's factory.check when left out. */
  check?: string;
  cwd?: string;
}

/** Run the check and attach its result as evidence to each criterion the factory ticks (#3406 rule 5). */
export async function factoryCheck(args: FactoryCheckArgs): Promise<FactoryCheckResult> {
  const lease = leaseOf(args.lease, "factoryCheck");
  if (!args.build.ran || !args.build.finished) return { ran: false, ok: false, command: null, evidence: [], log: null };
  let command = args.check ?? null;
  if (command === null) {
    const { readDeclaration } = await import("../../workspace/declaration");
    const { locateWorkspace } = await import("../../workspace/which-chant");
    command = readDeclaration(locateWorkspace(lease.worktree).tree).members.find((m) => m.box?.factory?.check)?.box?.factory?.check?.run ?? null;
  }
  if (command === null) return { ran: false, ok: false, command: null, evidence: [], log: null };
  const r = await run(await words(command), lease.worktree, { FACTORY_ITEM: lease.item, FACTORY_TOKEN: lease.token });
  const ok = r.code === 0;
  const log = `.chant/factory/${lease.item}/check.log`;
  const abs = join(lease.worktree, ...log.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `$ ${command}\nexit ${r.code}\n\n${r.stdout}${r.stderr ? `\n--- stderr ---\n${r.stderr}` : ""}`);
  const w = await readWork(lease.worktree);
  const item = w.items.get(lease.item);
  const evidence: string[] = [];
  const { attachWorkEvidence } = await import("../../workspace/work-evidence");
  for (const c of item?.acceptance ?? []) {
    if (c.verification === "manual" || c.verification === "runtime") continue;
    const out = await attachWorkEvidence({ cwd: lease.worktree, item: lease.item, holder: lease.holder, token: lease.token, criterion: c.id, result: ok ? "pass" : "fail", title: `factory check: ${command}`, path: log });
    if (!("error" in out)) evidence.push(c.id);
  }
  return { ran: true, ok, command, evidence, log };
}

export interface FactoryRecordArgs {
  lease: FactoryLease;
  ask: FactoryAskResult;
  build: FactoryBuildResult;
  check: FactoryCheckResult;
  cwd?: string;
}

/** The decisions a done build proposes it implements, from the intent graph of each path it changed (studio#243). */
async function proposals(worktree: string, base: string, already: string[]): Promise<{ decision: string; paths: string[] }[]> {
  const { proposeImplements } = await import("../../workspace/factory-rules");
  const changed = (await gitOut(["diff", "--name-only", base], worktree)).out.split("\n").filter((p) => p && !p.startsWith(".chant/"));
  const { intentGraph } = await import("../../workspace/intent");
  const rows: { path: string; decisions: { id: string; state: string | null; granularity: string }[] }[] = [];
  for (const path of changed.slice(0, 20)) {
    const { doc } = await intentGraph({ cwd: worktree, region: path });
    if ("error" in doc) continue;
    const decisions = new Map(doc.nodes.filter((n) => n.kind === "decision").map((n) => [n.id, n as unknown as { record: string; state: string | null }]));
    const out: { id: string; state: string | null; granularity: string }[] = [];
    for (const e of doc.edges as unknown as { kind: string; from: string; to: string; granularity?: string }[]) {
      if (e.kind !== "constrains") continue;
      const d = decisions.get(e.from);
      if (d) out.push({ id: d.record, state: d.state, granularity: e.granularity ?? "" });
    }
    rows.push({ path, decisions: out });
  }
  return proposeImplements(rows, already);
}

/** Record the outcome on the item's branch and name it for the lease's release (#3406 rules 4 to 6, 8). */
export async function factoryRecord(args: FactoryRecordArgs): Promise<FactoryRecordResult> {
  const lease = leaseOf(args.lease, "factoryRecord");
  const cwd = args.cwd ?? process.cwd();
  const root = await checkoutRoot(cwd);
  const w = await readWork(lease.worktree);
  const kindFile = inWorktree(w.kindFile, root, lease.worktree);
  const item = w.items.get(lease.item);
  if (!item) throw new Error(`no record of the work kind has id ${lease.item} in the worktree`);
  const none = { commit: null, implementsProposed: [] };
  if (args.ask.outcome === "redraft" || args.ask.outcome === "ask") return { outcome: args.ask.outcome, reason: `understand answered ${args.ask.understand}`, ...none };
  if (args.ask.outcome === "dropped") {
    await amend(lease.worktree, kindFile, lease.item, { [w.stateField]: "dropped", [w.work.closedOn]: today() });
    const commit = await commitAll(lease.worktree, `${lease.item}: dropped, the understand point refused it`, lease.item, w.kindName, lease.token);
    return { outcome: "dropped", reason: "understand answered refuse", commit, implementsProposed: [] };
  }
  const { doneVerdict } = await import("../../workspace/factory-rules");
  const verdict = doneVerdict(args.build, args.check, item.acceptance);
  if (!verdict.done) return { outcome: "not_done", reason: verdict.reason, ...none };
  const base = (await gitOut(["merge-base", "HEAD", (await gitOut(["rev-parse", "HEAD"], root)).out], lease.worktree)).out;
  const already = Array.isArray(item.data?.[w.work.implements]) ? (item.data![w.work.implements] as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const proposed = base ? await proposals(lease.worktree, base, already) : [];
  await amend(lease.worktree, kindFile, lease.item, {
    [w.stateField]: w.work.done,
    [w.work.closedOn]: today(),
    result: { lease: lease.token },
    ...(proposed.length > 0 ? { [w.work.implements]: [...already, ...proposed.map((p) => p.decision)], implements_proposed: proposed } : {}),
  });
  const title = typeof item.data?.title === "string" ? item.data.title : lease.item;
  const commit = await commitAll(lease.worktree, `${lease.item}: ${title}`, lease.item, w.kindName, lease.token);
  return { outcome: "done", reason: null, commit, implementsProposed: proposed };
}
