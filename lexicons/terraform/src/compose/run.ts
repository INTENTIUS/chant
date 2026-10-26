/**
 * A composed run over roots that keep state (chant#4444, epic #4419): one
 * plan and one apply of the composed root, with each member's state pulled
 * before and written back after, whatever the apply did.
 *
 * `plan()` inits each member against its backend, takes each state's lock
 * (when `lock` is set), writes first any state an earlier run kept unwritten,
 * pulls each state, writes the composed root and the working state, and
 * plans once. `apply()` applies that saved plan; whether it finished or
 * failed, it splits the working state, writes each changed state upstreams
 * first under its lock, and releases each lock once its state is written.
 * `release()` puts every file back, removes `.chant-compose/` and lets go of
 * every lock but one held on purpose for a state it could not write. Call it
 * whatever happened, a thrown error included. A plan the gate makes wait, or
 * refuses, is followed by `release()` alone: nothing is written.
 *
 * Nothing is atomic. A failure part way leaves what applied, applied, and
 * each member's state says so.
 *
 * Lifted from terragucci's `ComposedRun` (`packages/terragucci/src/compose.ts`,
 * lines 1143 to 1651 at c493e0e), composed from the pieces already in the
 * lexicon: `../state` (#4437) for locks, pulls, writes and the unwritten
 * keep; `./root` (#4441) for the composed root; `./state-merge`, `./slice`
 * and `./apply-events` (#4442) for the working state, each member's plan and
 * each member's outcome. Estates (`Composition.estate`) run through
 * `./estate`'s `EstateRun` (#4445); both implement its `ComposedRunner` and
 * return its `ComposedRunPlan` and `ComposedRunApply`, which this run extends.
 *
 * Like `EstateRun`, `plan()` does not throw for a plan that did not come to
 * be: it answers `error`, with `member` when the failure is about one (a
 * hook, an init, a lock held by another run), and releases every lock first.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { stateOutputs, stateResources } from "../applied-state";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import type { OpWaveHookMoment } from "@intentius/chant/op";
import type { Composition } from "../compose";
import type { TerraformConfig } from "../config";
import { plannerForBinary } from "../change-set";
import { terraformPlanDigest } from "../plan-digest";
import { lastLines, runBinary, type BinaryExec, type StateFile } from "../state/exec";
import { StateLockedError } from "../state/locks";
import { RootStates, StateRefusedError } from "../state/root-states";
import { composedApplyOutcomes } from "./apply-events";
import { COMPOSE_DIR, writeComposedRoot, withoutVarFiles, type ComposedRoot } from "./root";
import { composedMemberPlans, moduleOutputs, moduleValues, planCounts, sliceText } from "./slice";
import type { ComposedMemberOutcome, ComposedRunApply, ComposedRunner, ComposedRunPlan } from "./estate";
import { mergeStates, splitState } from "./state-merge";

/** The moments a member's hooks run at in a composed run: those of a member applied alone (#4288), less core's own `after-gate`. */
export type ComposeHookMoment = Exclude<OpWaveHookMoment, "after-gate">;

/**
 * Runs one moment's hooks for a member. A hook given the plan file gets the
 * composed one. A hook that failed returns its error, or throws.
 */
export type ComposeHook = (member: string, moment: ComposeHookMoment, planFile?: string) => Promise<string | undefined | void>;

export interface ComposedRunOptions {
  /** The checkout's root, where `chant.config.*` was loaded from: `.chant-compose/` is written here. */
  projectRoot: string;
  /** What `compositionFor` answered, with two or more members and no fallback. */
  composition: Composition;
  /** The config's `terraform` namespace: each root's `varFiles` and `backendConfig`. */
  terraform: TerraformConfig;
  /** The binary every member runs: its path, and its name when the path does not say it (`tofu`, `terraform`). */
  binary: { path: string; name?: string };
  /** The job's environment, with a shared provider cache when there is one. Every member runs under it. */
  env: NodeJS.ProcessEnv;
  /** A directory of the job's own for the plan file and the state files `state push` reads. */
  work: string;
  /** Take each state's lock. An apply needs them; a plan alone may go without. */
  lock: boolean;
  /** Names the run in the locks it takes. */
  runId?: string;
  exec?: BinaryExec;
  /** How long to wait before each retry of a state's write. Default `DEFAULT_RETRY_DELAYS` (#4437). */
  retryDelays?: number[];
  /** How a retry waits; a test passes one that does not. */
  sleep?: (ms: number) => Promise<void>;
  /** Runs each init, one at a time when the members share a provider cache. */
  initTurn?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Each member's hooks, at the moments a member applied alone runs them. */
  hook?: ComposeHook;
  /** Each member's step `vars` as written, by component (`memberVars`). */
  vars?: Readonly<Record<string, Record<string, unknown> | undefined>>;
  /** The outputs of components outside the group that a member's `vars` read. */
  componentOutputs?: Record<string, Record<string, unknown>>;
  /** Where a state goes when its backend cannot take the kept copy. Default `<work>/report`. */
  reportDir?: string;
  log?: (line: string) => void;
}

/** Where a composed run stopped before it planned. */
export type ComposedRunStage = "init" | "hook" | "lock" | "kept" | "pull" | "root" | "plan" | "show";

/** What the state-backed run's `plan()` answers: `ComposedRunPlan` (#4445) with the reads unknown at plan and where a failed plan stopped. */
export interface StateRunPlan extends ComposedRunPlan {
  /** The members that read a value of another member unknown at plan, sorted. */
  unknownReads: string[];
  /** Where a plan that did not come to be stopped, with {@link ComposedRunPlan.error}. */
  stage?: ComposedRunStage;
  /** The error underneath {@link ComposedRunPlan.error}: a `StateLockedError` names the lock's holder, a `StateRefusedError` each root chant does not lock. */
  underlying?: unknown;
}

/** What became of a member's state after the apply: written, left as pulled, or kept unwritten with its lock held. */
export type ComposedStateWrite = "written" | "unchanged" | "not-written";

/** One member's outcome of a state-backed composed apply: `ComposedMemberOutcome` (#4445) with what became of its state. */
export interface StateMemberOutcome extends ComposedMemberOutcome {
  state: ComposedStateWrite;
  /** The serial written, when `state` is `written`. */
  serial?: number;
  /** Where the state was kept, when `state` is `not-written` and there was one to keep. */
  kept?: string;
  /** Its lock stays held after `release()`. */
  lockHeld?: true;
}

/** How a state-backed composed apply ended: `ComposedRunApply` (#4445) with each member's state. */
export interface StateRunApply extends ComposedRunApply {
  /** Every member applied (or had no changes), every state settled, and no hook failed. */
  ok: boolean;
  members: Record<string, StateMemberOutcome>;
  /** The members whose state the run wrote or left as it was, in apply order: their backend holds what applied to them. */
  settled: string[];
  /** `show -json` of each member's part of the working state, as if it had applied alone: where the report reads the values its plan left unknown. Empty when the state could not be shown. */
  shown: Record<string, unknown>;
}

/** A plan that did not come to be, as `plan()` answers it. */
class PlanStopped extends Error {
  constructor(
    message: string,
    readonly stage: ComposedRunStage,
    readonly member?: string,
    readonly underlying?: unknown,
  ) {
    super(member && !message.startsWith(`${member}:`) ? `${member}: ${message}` : message);
  }
}

/** The group digest: chant's digest of the composed plan joined with the generated files. */
export function composedPlanDigest(plan: unknown, generated: readonly [string, string][]): string {
  return computePlanDigest("chant-terraform-composed-plan", { plan: terraformPlanDigest(plan), files: generated.map(([path, sha]) => `${path} ${sha}`) });
}

/** Whether a plan changes a resource (not a no-op or a read) or an output. */
export function changesSomething(plan: unknown): boolean {
  const p = plan as { resource_changes?: { change?: { actions?: string[] } }[]; output_changes?: Record<string, { actions?: string[] }> } | undefined;
  const real = (actions: string[] | undefined): boolean => (actions ?? []).some((a) => a !== "no-op" && a !== "read");
  return (p?.resource_changes ?? []).some((r) => real(r.change?.actions)) || Object.values(p?.output_changes ?? {}).some((o) => real(o.actions));
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class ComposedRun implements ComposedRunner {
  private readonly exec: BinaryExec;
  private readonly composeDir: string;
  private readonly states: RootStates;
  private readonly pulled = new Map<string, StateFile | null>();
  private root?: ComposedRoot;
  private planned?: StateRunPlan;
  private released = false;

  constructor(private readonly o: ComposedRunOptions) {
    const c = o.composition;
    if (c.fallback || c.members.length < 2) throw new Error(`nothing composes${c.fallback ? `: ${c.fallback.reason}` : ""}`);
    if (c.estate) throw new Error("the composition is one of estates, which has no state to pull or write back (#4445)");
    this.exec = o.exec ?? runBinary;
    this.composeDir = join(resolve(o.projectRoot), COMPOSE_DIR);
    this.states = new RootStates({
      roots: c.order.map((m) => {
        const backendConfig = o.terraform.roots[c.roots.get(m) ?? m]?.backendConfig;
        return { root: m, dir: this.dirOf(m), env: o.env, ...(backendConfig ? { backendConfig } : {}) };
      }),
      binary: o.binary.path,
      exec: this.exec,
      ...(o.runId ? { runId: o.runId } : {}),
      work: o.work,
      reportDir: o.reportDir ?? join(o.work, "report"),
      ...(o.retryDelays ? { retryDelays: o.retryDelays } : {}),
      ...(o.sleep ? { sleep: o.sleep } : {}),
      ...(o.log ? { log: o.log } : {}),
    });
  }

  private get c(): Composition {
    return this.o.composition;
  }

  private dirOf(member: string): string {
    const d = this.c.dirs.get(member);
    if (!d) throw new Error(`${member} has no root directory in the composition`);
    return d;
  }

  private log(line: string): void {
    this.o.log?.(line);
  }

  private get binaryName(): string {
    return this.o.binary.name ?? basename(this.o.binary.path);
  }

  /** The locks held now, by member. */
  held(): string[] {
    return this.states.held();
  }

  /**
   * The composed root's environment: the job's, its `-var-file` flags taken
   * out (the composed root passes those values as module arguments). With a
   * shared provider cache and no lock file to check a cached provider
   * against, the cache may fill the lock file, as a root's own plan lets it.
   */
  private composedEnv(): NodeJS.ProcessEnv {
    const env = withoutVarFiles(this.o.env);
    return env.TF_PLUGIN_CACHE_DIR && !existsSync(join(this.composeDir, ".terraform.lock.hcl")) ? { ...env, TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE: "true" } : env;
  }

  private async hook(member: string, moment: ComposeHookMoment, planFile?: string): Promise<string | undefined> {
    if (!this.o.hook) return undefined;
    try {
      return (await this.o.hook(member, moment, planFile)) || undefined;
    } catch (e) {
      return (e as Error).message || String(e);
    }
  }

  private turn<T>(fn: () => Promise<T>): Promise<T> {
    return this.o.initTurn ? this.o.initTurn(fn) : fn();
  }

  private writeComposed(): ComposedRoot {
    return writeComposedRoot({
      projectRoot: this.o.projectRoot,
      composition: this.c,
      terraform: this.o.terraform,
      env: this.o.env,
      ...(this.o.vars ? { vars: this.o.vars } : {}),
      ...(this.o.componentOutputs ? { componentOutputs: this.o.componentOutputs } : {}),
    });
  }

  /** Put the composed root's files back, when they are written. */
  private restoreRoot(): void {
    const r = this.root;
    this.root = undefined;
    r?.restore();
  }

  /**
   * Init each member, take each lock (with `lock`), write first any state an
   * earlier run kept unwritten, pull each state, write the composed root and
   * the working state, and plan once. A plan that does not come to be
   * answers `error`, with `member` when it is about one, after releasing
   * every lock and putting every file back.
   */
  async plan(): Promise<StateRunPlan> {
    if (this.released) throw new Error("this composed run was released");
    try {
      return await this.planOnce();
    } catch (e) {
      await this.release();
      const stopped = e instanceof PlanStopped ? e : new PlanStopped((e as Error).message, "plan", undefined, e);
      return {
        members: {},
        digest: "",
        error: stopped.message,
        ...(stopped.member !== undefined ? { member: stopped.member } : {}),
        stage: stopped.stage,
        ...(stopped.underlying !== undefined ? { underlying: stopped.underlying } : {}),
        unknownReads: [],
        planFile: join(this.o.work, "composed.tfplan"),
        text: "",
        texts: {},
        generated: [],
        counts: { add: 0, change: 0, destroy: 0, changes: 0, destroys: 0 },
        summary: "",
      };
    }
  }

  private async planOnce(): Promise<StateRunPlan> {
    const bin = this.o.binary.path;
    for (const m of this.c.order) {
      const err = await this.hook(m, "before-observe");
      if (err) throw new PlanStopped(`a before-observe hook failed: ${err}`, "hook", m);
      const backendConfig = this.o.terraform.roots[this.c.roots.get(m) ?? m]?.backendConfig ?? {};
      const args = ["init", "-input=false", "-no-color", ...Object.entries(backendConfig).map(([k, v]) => `-backend-config=${k}=${v}`)];
      const init = await this.turn(() => this.exec(bin, args, this.dirOf(m), this.o.env));
      if (init.code !== 0) throw new PlanStopped(`init failed: ${lastLines(init.out, 8)}`, "init", m);
    }
    if (this.o.lock) {
      try {
        await this.states.take();
      } catch (e) {
        if (e instanceof StateLockedError) throw new PlanStopped(e.message, "lock", e.root, e);
        if (e instanceof StateRefusedError) throw new PlanStopped(e.message, "lock", e.refusals.length === 1 ? e.refusals[0]!.root : undefined, e);
        throw new PlanStopped((e as Error).message, "kept", undefined, e);
      }
    }
    for (const m of this.c.order) {
      try {
        this.pulled.set(m, await this.states.pull(m));
      } catch (e) {
        throw new PlanStopped((e as Error).message, "pull", m, e);
      }
    }
    for (const m of this.c.order) {
      const err = await this.hook(m, "before-plan");
      if (err) throw new PlanStopped(`a before-plan hook failed: ${err}`, "hook", m);
    }

    mkdirSync(this.o.work, { recursive: true });
    const planFile = join(this.o.work, "composed.tfplan");
    rmSync(planFile, { force: true });
    try {
      this.root = this.writeComposed();
    } catch (e) {
      throw new PlanStopped(`the composed root could not be written: ${(e as Error).message}`, "root", undefined, e);
    }
    const generated = this.root.generated;
    let plan: unknown;
    let text = "";
    let summary = "";
    try {
      writeFileSync(join(this.composeDir, "terraform.tfstate"), JSON.stringify(mergeStates(this.c, this.pulled), null, 2) + "\n");
      const env = this.composedEnv();
      const init = await this.turn(() => this.exec(bin, ["init", "-input=false", "-no-color"], this.composeDir, env));
      if (init.code !== 0) throw new PlanStopped(`the composed root's init failed: ${lastLines(init.out, 8)}`, "init");
      const p = await this.exec(bin, ["plan", "-input=false", "-no-color", "-lock=false", `-out=${planFile}`], this.composeDir, env);
      if (p.code !== 0 || !existsSync(planFile)) throw new PlanStopped(`the composed plan failed: ${lastLines(p.out, 8)}`, "plan");
      summary = p.stdout.match(/Plan: .*|No changes\..*/)?.[0] ?? "planned";
      const json = await this.exec(bin, ["show", "-json", planFile], this.composeDir, env);
      try {
        plan = JSON.parse(json.stdout);
      } catch {
        throw new PlanStopped(`show -json printed no plan: ${lastLines(json.out)}`, "show");
      }
      text = (await this.exec(bin, ["show", "-no-color", planFile], this.composeDir, env)).stdout;
    } finally {
      this.restoreRoot();
    }
    for (const m of this.c.order) {
      const err = await this.hook(m, "after-plan", planFile);
      if (err) throw new PlanStopped(`an after-plan hook failed: ${err}`, "hook", m);
    }

    const members = composedMemberPlans(this.c, plan, { planner: plannerForBinary(this.binaryName) });
    const texts = Object.fromEntries(this.c.order.map((m) => [m, sliceText(text, this.c.modules.get(m)!, members[m]!.counts)] as const));
    const unknownReads = this.c.order.filter((m) => members[m]!.reads.some((r) => r.unknown.length > 0)).sort();
    this.planned = { members, texts, unknownReads, digest: composedPlanDigest(plan, generated), generated, planFile, plan, text, counts: planCounts(plan), summary };
    return this.planned;
  }

  /** Every member's outcome when nothing applied and no state was touched. */
  private nothingApplied(error: string, member?: string, memberError?: string): StateRunApply {
    const members: Record<string, StateMemberOutcome> = {};
    for (const m of this.c.order) {
      const planned = this.planned?.members[m]?.counts.changes ?? 0;
      members[m] = { status: "not-started", planned, done: 0, state: "unchanged", ...(m === member && memberError ? { error: memberError } : {}) };
    }
    return { ok: false, members, settled: [], shown: {}, error };
  }

  /**
   * Apply the saved plan, then split the working state by module and write
   * each changed state, upstreams first, whether the apply finished or not.
   * Each lock is released once its state is written or found as pulled; one
   * whose state could not be written stays held, and the state is kept
   * beside it.
   */
  async apply(): Promise<StateRunApply> {
    const p = this.planned;
    if (this.released) throw new Error("this composed run was released");
    if (!p || p.error) return this.nothingApplied("the composed run did not plan");
    if (!this.o.lock) return this.nothingApplied("a composed run applies only with its locks held (`lock`)");

    for (const m of this.c.order) {
      const err = await this.hook(m, "before-apply", p.planFile);
      if (err) return this.nothingApplied(`a before-apply hook of ${m} failed, so nothing applied`, m, err);
    }
    try {
      this.root = this.writeComposed();
    } catch (e) {
      return this.nothingApplied(`the composed root could not be written: ${(e as Error).message}`);
    }
    let out = "";
    let code = 1;
    try {
      if (!sameJson(this.root.generated, p.generated)) return this.nothingApplied("the composed root differs from the one planned, so nothing applied");
      const a = await this.exec(this.o.binary.path, ["apply", "-json", "-input=false", "-no-color", p.planFile], this.composeDir, this.composedEnv());
      out = a.stdout;
      code = a.code;
      for (const line of a.stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = (JSON.parse(line) as { "@message"?: string })["@message"];
          if (msg && !/^(Plan to|Refreshing|Reading)/.test(msg)) this.log(`composed: ${msg}`);
        } catch {
          this.log(`composed: ${line}`);
        }
      }
      if (code !== 0 && !out.trim()) this.log(`composed: ${lastLines(a.out, 8)}`);
    } finally {
      this.restoreRoot();
    }

    const planned = new Map(this.c.order.map((m) => [m, p.members[m]!.counts.changes] as const));
    const outcomes = composedApplyOutcomes(this.c, planned, out);
    const errored = join(this.composeDir, "errored.tfstate");
    const workingFile = existsSync(errored) ? errored : join(this.composeDir, "terraform.tfstate");
    let working: StateFile;
    try {
      working = JSON.parse(readFileSync(workingFile, "utf-8")) as StateFile;
    } catch (e) {
      // With no working state to split nothing is written, and every lock stays held: what applied is only in the binary's output.
      const why = `the working state could not be read after the apply: ${(e as Error).message}`;
      const members: Record<string, StateMemberOutcome> = {};
      for (const m of this.c.order) {
        this.states.hold(m);
        const o = outcomes.members[m]!;
        members[m] = { status: o.status, planned: planned.get(m) ?? 0, done: o.done, state: "not-written", lockHeld: true, error: o.error ?? why };
      }
      return { ok: false, members, settled: [], shown: {}, error: why };
    }

    const shown = await this.showMembers(workingFile);
    const members: Record<string, StateMemberOutcome> = {};
    const settled: string[] = [];
    for (const m of this.c.order) {
      const o = outcomes.members[m]!;
      const row: StateMemberOutcome = { status: o.status, planned: planned.get(m) ?? 0, done: o.done, state: "unchanged", ...(o.error ? { error: o.error } : {}) };
      const split = splitState(working, this.c, m, this.pulled.get(m) ?? null);
      if (!changesSomething(p.members[m]!.slice) || split.same) {
        settled.push(m);
        await this.states.release(m);
      } else {
        const w = await this.states.write(m, split.state);
        if (w.written) {
          row.state = "written";
          row.serial = split.state.serial;
          settled.push(m);
          this.log(`${m}: wrote its state, serial ${split.state.serial}`);
          await this.states.release(m);
        } else {
          Object.assign(row, { state: "not-written" as const, kept: w.kept, lockHeld: true as const, error: row.error ? `${row.error}; ${w.error}` : w.error });
        }
      }
      if (shown[m] !== undefined) {
        row.resources = stateResources(shown[m]);
        if (row.status === "applied" || row.status === "no-changes") row.outputs = stateOutputs(shown[m]);
      }
      members[m] = row;
    }
    for (const m of this.c.order) {
      const row = members[m]!;
      if (row.status !== "applied" && row.status !== "no-changes") continue;
      const err = await this.hook(m, "after-apply");
      if (err) row.error = row.error ? `${row.error}; an after-apply hook failed: ${err}` : `an after-apply hook failed: ${err}`;
    }
    const rows = Object.values(members);
    const ok = code === 0 && rows.every((r) => (r.status === "applied" || r.status === "no-changes") && r.state !== "not-written" && !r.error);
    const error = ok ? undefined : (outcomes.other[0] ?? (code !== 0 ? "the composed apply failed" : rows.find((r) => r.error)?.error));
    return { ok, members, settled, shown, ...(error ? { error } : {}) };
  }

  /**
   * `show -json` of the working state, cut into each member's part (its
   * module as the root module, addresses and outputs unprefixed). Empty when
   * the state cannot be shown: the report then leaves the values unknown.
   * Never fails the run.
   */
  private async showMembers(workingFile: string): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    try {
      // `show` reads the state the root holds; the errored state is shown by naming its file.
      const args = workingFile.endsWith("errored.tfstate") ? ["show", "-json", "-no-color", workingFile] : ["show", "-json", "-no-color"];
      const r = await this.exec(this.o.binary.path, args, this.composeDir, this.composedEnv());
      if (r.code !== 0) return out;
      const whole = JSON.parse(r.stdout) as { values?: { outputs?: unknown } };
      for (const m of this.c.order) {
        const mod = this.c.modules.get(m)!;
        out[m] = { ...whole, values: moduleValues(whole.values, mod, moduleOutputs(whole.values?.outputs, mod)) };
      }
    } catch (e) {
      this.log(`composed: the applied state could not be shown (${(e as Error).message}); the values unknown at plan stay unknown in the report`);
    }
    return out;
  }

  /**
   * Put every root file back, remove `.chant-compose/`, and release every
   * lock but one held on purpose for a state that could not be written.
   * Safe to call more than once, and after a thrown error.
   * {@link heldOnPurpose} names the members whose lock it leaves held.
   */
  async release(): Promise<void> {
    this.released = true;
    let restoreError: unknown;
    try {
      this.restoreRoot();
    } catch (e) {
      restoreError = e;
    }
    await this.states.release();
    rmSync(this.composeDir, { recursive: true, force: true });
    if (restoreError) throw restoreError;
  }

  /** The members whose lock stays held past {@link release}, for a state that could not be written. */
  heldOnPurpose(): string[] {
    return this.states.heldOnPurposeRoots();
  }
}
