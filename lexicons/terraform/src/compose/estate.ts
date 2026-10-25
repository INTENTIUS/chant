/**
 * The composed run of choudoufu estates (chant#4445, epic #4419): when every
 * member runs choudoufu against a `live` estate (`Composition.estate`), one
 * `choudoufu plan` and one `choudoufu apply` from a composed root of `module`
 * calls (choudoufu#2059).
 *
 * An estate has no state file, so nothing is pulled, locked, split or
 * written back: each resource's record goes to its own estate as it applies,
 * and a `terraform_estate_outputs` read of another estate in the run is
 * answered inside the run. The composed root is `writeEstateRoot`'s
 * (./root.ts, #4441). The run takes the job's environment and assumes no
 * role of its own: each estate's provider blocks name its role.
 *
 * choudoufu refuses a bare `show` under a `live` block, so the values the
 * plan left unknown are read after the apply from a second plan of the
 * composed root: its `prior_state`, sliced per module (./slice.ts, #4442) and
 * read through `../applied-state`, the reader `chant terraform report` uses.
 * The same plan says how far a failed apply got: a member whose part plans
 * no change any more applied.
 *
 * Lifted from terragucci's `packages/terragucci/src/compose.ts` at c493e0e
 * (`ComposedRun` with `estate` set: `plan`, `apply`, `finishEstate`,
 * `showEstateMembers`, `composedEnv`). The state-backed run is #4444; this one
 * has the same `plan()`, `apply()` and `release()` and returns the same
 * shapes, and #4447 picks one by `Composition.estate`.
 */

import { existsSync, mkdtempSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CapabilityGroupOutcome, CapabilityGroupPlan, GroupMemberOutcome } from "@intentius/chant/components/capability";
import type { ComposeFallback, Composition } from "../compose";
import type { TerraformConfig } from "../config";
import { stateOutputs, stateResources, type StateResourceValues } from "../applied-state";
import { terraformPlanDigest } from "../plan-digest";
import { terraformPlannedOutputs } from "../components/capability-plugin";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { isOlderVersion, MIN_CHOUDOUFU_ESTATES_VERSION, parseChoudoufuVersion } from "../op/activities/terraform";
import { runBinary, type BinaryExec } from "../state/exec";
import { memberApply, type ApplyEvents, type MemberApply } from "./apply-events";
import { liveEstate } from "./hcl";
import { stripModule, topModule } from "./module-address";
import { COMPOSE_DIR, withoutVarFiles, writeEstateRoot, type ComposedRoot } from "./root";
import { composedMemberPlans, planCounts, slicePlan, sliceText, type ComposedMemberPlan, type PlanCounts } from "./slice";

/** What a composed run's `plan()` answers. Assignable to core's `CapabilityGroupPlan` (ws-107). */
export interface ComposedRunPlan extends CapabilityGroupPlan {
  /** Each member's part of the plan, by component. Empty when the run fell back or the plan failed. */
  members: Record<string, ComposedMemberPlan>;
  /** What the approval binds beside the members' own plans: the composed plan and the generated files. Empty when nothing planned. */
  digest: string;
  /** Why the run did not plan as one: the members plan wave by wave instead. Decided before anything planned. */
  fallback?: ComposeFallback;
  /** Why the composed plan failed: every member is plan-failed. */
  error?: string;
  /** The member {@link error} is about, when it is about one (a hook, an init, a lock). */
  member?: string;
  /** The composed plan's `show -json`. */
  plan?: unknown;
  /** The saved plan file `apply()` applies. */
  planFile: string;
  /** The composed plan's `show` text. */
  text: string;
  /** Each member's part of the `show` text, by component. */
  texts: Record<string, string>;
  /** sha256 of each generated file of the composed root, as `ComposedRoot.generated`. */
  generated: [string, string][];
  /** The whole run's counts. */
  counts: PlanCounts;
  /** The binary's `Plan:` line for the whole run. */
  summary: string;
}

/** One member's outcome of a composed apply. Assignable to core's `GroupMemberOutcome` (ws-107). */
export interface ComposedMemberOutcome extends GroupMemberOutcome {
  status: MemberApply;
  /** Its planned changes. */
  planned: number;
  /** Its planned changes that completed. */
  done: number;
  /** Each resource of its part of the state after the apply, by address with its module taken off. */
  resources?: Map<string, StateResourceValues>;
}

/** What a composed run's `apply()` answers. Assignable to core's `CapabilityGroupOutcome` (ws-107). */
export interface ComposedRunApply extends CapabilityGroupOutcome {
  /** Every member applied or had no changes, and the binary exited 0. */
  ok: boolean;
  members: Record<string, ComposedMemberOutcome>;
  /** `show -json` of the plan made after the apply. Absent when it could not be made. */
  after?: unknown;
}

/** The surface #4447 drives, whichever run `Composition.estate` picks. */
export interface ComposedRunner {
  plan(): Promise<ComposedRunPlan>;
  apply(): Promise<ComposedRunApply>;
  release(): Promise<void>;
}

export interface EstateRunOptions {
  /** The checkout's root: where `chant.config.*` was loaded from. `.chant-compose/` is written here. */
  projectRoot: string;
  /** What `compositionFor` answered, with `estate` set and two or more members. */
  composition: Composition;
  /** The config's `terraform` namespace: a root's `estate`. */
  terraform: TerraformConfig;
  /** The job's environment. The run adds no role to it. */
  env: NodeJS.ProcessEnv;
  /** The choudoufu binary, by name or path. Default `terraform.binary`, else `choudoufu`. */
  binary?: string;
  /** Where the plan files go. Default: a new directory under the system's temp directory. */
  work?: string;
  /** How the binary runs. Default {@link runBinary}; a test injects a fake. */
  exec?: BinaryExec;
  log?: (line: string) => void;
}

const firstLines = (s: string, n = 20): string => s.trim().split("\n").slice(-n).join("\n");

/**
 * Why a choudoufu's `version` output cannot run a composed run of estates, or
 * undefined when it can. A release older than
 * {@link MIN_CHOUDOUFU_ESTATES_VERSION} falls back; a dev build names no
 * release and passes.
 */
export function estateVersionFallback(versionOutput: string): ComposeFallback | undefined {
  const version = parseChoudoufuVersion(versionOutput);
  if (version === undefined || !isOlderVersion(version, MIN_CHOUDOUFU_ESTATES_VERSION)) return undefined;
  return {
    kind: "binary",
    reason: `choudoufu ${version} is older than v${MIN_CHOUDOUFU_ESTATES_VERSION}, the first release that plans and applies several estates as one (choudoufu#2059)`,
  };
}

/**
 * What choudoufu's human `apply` output says of each module: the changes
 * that completed (`<addr>: Creation complete`, `Modifications complete`,
 * `Destruction complete`), started (`Creating...` and the rest) or errored
 * (an `Error:` box naming `with <addr>,`). An estate's apply runs under live
 * resource markers and prints no `-json` lines, so this reads the text.
 */
export function readEstateApplyText(out: string, modules: readonly string[]): ApplyEvents {
  const ev: ApplyEvents = { done: new Map(), started: new Map(), errored: new Map(), other: [] };
  const known = new Set(modules);
  const moduleOf = (addr: string): string | undefined => {
    const m = topModule(addr);
    return m !== undefined && known.has(m) && addr !== `module.${m}` ? m : undefined;
  };
  const bump = (map: Map<string, number>, m: string): void => {
    map.set(m, (map.get(m) ?? 0) + 1);
  };
  const lines = out.split("\n").map((l) => l.replace(/^[│╷╵\s]+/, "").trimEnd());
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const hit = l.match(/^(module\.\S+): (Creation|Modifications|Destruction) complete\b/);
    if (hit) {
      const m = moduleOf(hit[1]!);
      if (m) bump(ev.done, m);
      continue;
    }
    const start = l.match(/^(module\.\S+): (Creating|Modifying|Destroying)\.\.\./);
    if (start) {
      const m = moduleOf(start[1]!);
      if (m) bump(ev.started, m);
      continue;
    }
    if (l.startsWith("Error: ")) {
      let addr: string | undefined;
      for (let j = i + 1; j < Math.min(lines.length, i + 8) && !lines[j]!.startsWith("Error: "); j++) {
        const w = lines[j]!.match(/^with (module\.[^,\s]+),?$/);
        if (w) {
          addr = w[1]!;
          break;
        }
      }
      const m = addr ? moduleOf(addr) : undefined;
      if (m && !ev.errored.has(m)) ev.errored.set(m, `${stripModule(addr!)}: ${l}`);
      else if (!m) ev.other.push(l);
    }
  }
  return ev;
}

/**
 * Each member's outcome from its planned changes, what the apply printed, its
 * exit code and, when the post-apply plan was made, the changes each member's
 * part still plans. A clean exit means every planned change applied. After a
 * failure, a member's changes left in the post-apply plan say how many of its
 * planned changes applied; without that plan the printed completions do.
 */
export function estateOutcomes(
  c: Pick<Composition, "order" | "modules">,
  planned: ReadonlyMap<string, number>,
  out: string,
  code: number,
  remaining?: ReadonlyMap<string, number>,
): { members: Record<string, { status: MemberApply; done: number; planned: number; error?: string }>; other: string[] } {
  const ev = readEstateApplyText(out, c.order.map((member) => c.modules.get(member)!));
  for (const member of c.order) {
    const m = c.modules.get(member)!;
    const n = planned.get(member) ?? 0;
    if (code === 0) ev.done.set(m, n);
    else if (remaining?.has(member)) ev.done.set(m, Math.max(0, n - remaining.get(member)!));
  }
  const members: Record<string, { status: MemberApply; done: number; planned: number; error?: string }> = {};
  for (const member of c.order) {
    const m = c.modules.get(member)!;
    const n = planned.get(member) ?? 0;
    const { apply, done } = memberApply(m, n, ev);
    const error = ev.errored.get(m);
    members[member] = { status: apply, done, planned: n, ...(error && apply !== "applied" && apply !== "no-changes" ? { error } : {}) };
  }
  return { members, other: ev.other };
}

/**
 * One composed run of estates: `plan()`, then `apply()` once the approval is
 * given, then `release()` whatever happened. No call reads, locks or writes
 * a state.
 */
export class EstateRun implements ComposedRunner {
  private readonly exec: BinaryExec;
  private readonly binary: string;
  private readonly composeDir: string;
  private readonly work: string;
  private readonly madeWork: boolean;
  private planned?: ComposedRunPlan;
  private root?: ComposedRoot;

  constructor(private readonly o: EstateRunOptions) {
    const c = o.composition;
    if (!c.estate || c.fallback || c.members.length < 2) throw new Error(`EstateRun runs a composition of estates with two or more members${c.fallback ? `; this one fell back: ${c.fallback.reason}` : ""}`);
    this.exec = o.exec ?? runBinary;
    this.binary = o.binary ?? o.terraform.binary ?? "choudoufu";
    this.composeDir = join(resolve(o.projectRoot), COMPOSE_DIR);
    this.madeWork = o.work === undefined;
    this.work = o.work ?? mkdtempSync(join(tmpdir(), "chant-compose-estate-"));
  }

  private get c(): Composition {
    return this.o.composition;
  }

  private log(line: string): void {
    this.o.log?.(line);
  }

  /**
   * The composed root's environment: the job's, with no role added (each
   * estate's provider blocks name its role) and its `-var-file` flags taken
   * out. With a shared provider cache and no lock file to check a cached
   * provider against, the cache may fill the lock file.
   */
  private env(): NodeJS.ProcessEnv {
    const env = withoutVarFiles(this.o.env);
    return env.TF_PLUGIN_CACHE_DIR && !existsSync(join(this.composeDir, ".terraform.lock.hcl")) ? { ...env, TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE: "true" } : env;
  }

  /** The estate each member's records go to: its root's `estate`, else its `live` block's. */
  private estateOf(member: string): string | undefined {
    const key = this.c.roots.get(member);
    return (key !== undefined ? this.o.terraform.roots[key]?.estate : undefined) ?? liveEstate(this.c.dirs.get(member)!).estate;
  }

  private notPlanned(extra: { fallback?: ComposeFallback; error?: string }): ComposedRunPlan {
    return {
      members: {},
      digest: "",
      planFile: join(this.work, "composed.tfplan"),
      text: "",
      texts: {},
      generated: [],
      counts: { add: 0, change: 0, destroy: 0, changes: 0, destroys: 0 },
      summary: "",
      ...extra,
    };
  }

  /**
   * Why this choudoufu cannot run the composition, or undefined. Runs
   * `choudoufu version`; what #4447's `groupFallback` asks before planning.
   */
  async fallback(): Promise<ComposeFallback | undefined> {
    const v = await this.exec(this.binary, ["version"], resolve(this.o.projectRoot), this.o.env);
    // A binary that cannot say its version is left to the plan, which says why it fails.
    return v.code === 0 ? estateVersionFallback(v.stdout) : undefined;
  }

  private writeRoot(): ComposedRoot {
    this.root = writeEstateRoot({ projectRoot: this.o.projectRoot, composition: this.c });
    return this.root;
  }

  private restoreRoot(): void {
    const r = this.root;
    this.root = undefined;
    r?.restore();
  }

  /**
   * Check the binary's version, write the composed root, init it and plan
   * once, then cut the plan into each member's part. The composed root is
   * taken away again before this returns.
   */
  async plan(): Promise<ComposedRunPlan> {
    const fallback = await this.fallback();
    if (fallback) {
      this.log(`composed: ${fallback.reason}; the estates plan wave by wave`);
      return this.notPlanned({ fallback });
    }
    let root: ComposedRoot;
    try {
      root = this.writeRoot();
    } catch (e) {
      return this.notPlanned({ error: `the composed root could not be written: ${(e as Error).message}` });
    }
    const planFile = join(this.work, "composed.tfplan");
    let plan: unknown;
    let text = "";
    let summary = "";
    try {
      const env = this.env();
      const init = await this.exec(this.binary, ["init", "-input=false", "-no-color"], this.composeDir, env);
      if (init.code !== 0) return this.notPlanned({ error: `the composed root's init failed\n${firstLines(init.out)}` });
      const p = await this.exec(this.binary, ["plan", "-input=false", "-no-color", `-out=${planFile}`], this.composeDir, env);
      if (p.code !== 0) return this.notPlanned({ error: `the composed plan failed\n${firstLines(p.out)}` });
      summary = p.stdout.match(/Plan: .*|No changes\..*/)?.[0] ?? "planned";
      const json = await this.exec(this.binary, ["show", "-json", planFile], this.composeDir, env);
      try {
        plan = JSON.parse(json.stdout);
      } catch {
        return this.notPlanned({ error: `show -json printed no plan\n${firstLines(json.out, 6)}` });
      }
      text = (await this.exec(this.binary, ["show", "-no-color", planFile], this.composeDir, env)).stdout;
    } finally {
      this.restoreRoot();
    }
    const members = composedMemberPlans(this.c, plan, { planner: "choudoufu", scope: (m) => this.estateOf(m) });
    const texts = Object.fromEntries(this.c.order.map((m) => [m, sliceText(text, this.c.modules.get(m)!, members[m]!.counts)] as const));
    const digest = computePlanDigest("terraform-compose-estate", { plan: terraformPlanDigest(plan), modules: this.c.order.map((m) => [m, this.c.modules.get(m)]), generated: root.generated });
    this.planned = { members, digest, plan, planFile, text, texts, generated: root.generated, counts: planCounts(plan), summary };
    return this.planned;
  }

  /**
   * Apply the saved plan from the composed root, then plan again and read
   * each member's values from that plan's `prior_state`. A failed apply
   * leaves what applied applied, and each member's outcome says how far its
   * part got.
   */
  async apply(): Promise<ComposedRunApply> {
    const p = this.planned;
    const notStarted = (error: string): ComposedRunApply => ({
      ok: false,
      members: Object.fromEntries(this.c.order.map((m) => [m, { status: "not-started" as const, planned: p?.members[m]?.counts.changes ?? 0, done: 0 }] as const)),
      error,
    });
    if (!p?.plan) return notStarted("the composed run did not plan");
    let root: ComposedRoot;
    try {
      root = this.writeRoot();
    } catch (e) {
      return notStarted(`the composed root could not be written: ${(e as Error).message}`);
    }
    let out = "";
    let code = 1;
    let after: unknown;
    try {
      if (JSON.stringify(root.generated) !== JSON.stringify(p.generated)) return notStarted("the composed root differs from the one planned, so nothing applied");
      const a = await this.exec(this.binary, ["apply", "-input=false", "-no-color", p.planFile], this.composeDir, this.env());
      out = a.out;
      code = a.code;
      for (const line of a.stdout.split("\n")) if (line.trim()) this.log(`composed: ${line}`);
      after = await this.planAfter();
    } finally {
      this.restoreRoot();
    }
    const planned = new Map(this.c.order.map((m) => [m, p.members[m]!.counts.changes] as const));
    const slices = after !== undefined ? new Map(this.c.order.map((m) => [m, slicePlan(after, this.c.modules.get(m)!)] as const)) : undefined;
    const remaining = slices ? new Map(this.c.order.map((m) => [m, planCounts(slices.get(m)).changes] as const)) : undefined;
    const ended = estateOutcomes(this.c, planned, out, code, remaining);
    const members: Record<string, ComposedMemberOutcome> = {};
    for (const m of this.c.order) {
      const row: ComposedMemberOutcome = { ...ended.members[m]! };
      const slice = slices?.get(m);
      if (slice !== undefined) {
        row.resources = stateResources(slice);
        if (row.status === "applied" || row.status === "no-changes") {
          // A state choudoufu builds from records may carry no root outputs; the same plan's planned outputs, all known after the apply, stand in.
          const outputs = stateOutputs(slice);
          row.outputs = Object.keys(outputs).length > 0 ? outputs : terraformPlannedOutputs(slice).known;
        }
      }
      members[m] = row;
    }
    const ok = code === 0 && Object.values(members).every((x) => x.status === "applied" || x.status === "no-changes");
    const error = ok ? undefined : (ended.other[0] ?? Object.values(members).find((x) => x.error)?.error ?? "the composed apply failed");
    return { ok, members, ...(after !== undefined ? { after } : {}), ...(error ? { error } : {}) };
  }

  /**
   * `show -json` of a plan of the composed root made after the apply, whose
   * `prior_state` choudoufu builds from the records and the live system.
   * Undefined when it cannot be made: the values unknown at plan then stay
   * unknown. Never fails the run.
   */
  private async planAfter(): Promise<unknown> {
    const planFile = join(this.work, "composed-after.tfplan");
    const env = this.env();
    try {
      const p = await this.exec(this.binary, ["plan", "-input=false", "-no-color", `-out=${planFile}`], this.composeDir, env);
      if (p.code !== 0) {
        this.log(`composed: the estates could not be planned after the apply; the values unknown at plan stay unknown\n${firstLines(p.out)}`);
        return undefined;
      }
      const s = await this.exec(this.binary, ["show", "-json", planFile], this.composeDir, env);
      if (s.code !== 0) return undefined;
      return JSON.parse(s.stdout) as unknown;
    } catch (e) {
      this.log(`composed: the estates could not be read after the apply (${(e as Error).message}); the values unknown at plan stay unknown`);
      return undefined;
    }
  }

  /**
   * Take the composed root away if a call left it, with the binary's working
   * files under `.chant-compose/`, and the plan files. There is no lock to
   * let go of. Safe to call more than once.
   */
  async release(): Promise<void> {
    this.restoreRoot();
    for (const f of [".terraform", ".terraform.lock.hcl"]) rmSync(join(this.composeDir, f), { recursive: true, force: true });
    try {
      if (existsSync(this.composeDir) && readdirSync(this.composeDir).length === 0) rmdirSync(this.composeDir);
    } catch {
      // Gone already.
    }
    if (this.madeWork) rmSync(this.work, { recursive: true, force: true });
    else for (const f of ["composed.tfplan", "composed-after.tfplan"]) rmSync(join(this.work, f), { force: true });
    this.planned = undefined;
  }
}
