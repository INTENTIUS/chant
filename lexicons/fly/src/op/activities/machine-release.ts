/**
 * The release a Fly Machine serves, and the Machines activities that put one
 * there (#2736, ws-056).
 *
 * chud's `Chud::FlySite` ran a site as one App served by one Machine and kept
 * the release in the Machine's metadata. That moves here: the App and the
 * Machine are this lexicon's own resources, and a release is the declared
 * Machine with {@link RELEASE_METADATA_KEYS} stamped into its
 * `config.metadata`. Because the record is on the Machine itself, any checkout
 * can read which release is serving (`describeResources` reports it, and
 * `chant components status --live` compares it with the release ledger).
 *
 * The site steps are activities over the Machines API, each usable from an
 * Op by name and composed by the `fly-release` and `fly-rollback` capabilities
 * (../../components/fly-release.ts):
 *
 * - {@link flyMachineRelease}: upload and start. Apply the declared plan with
 *   the Machine serving the release (its image or env overridden when the
 *   release says so), and report the release and config it replaced. A
 *   scheduled Machine (`config.schedule`, #4696) is updated without starting:
 *   it runs on its schedule. The plan's other Machines can take images of
 *   their own (`images`). Given `checks` (#4719), each Machine it starts must
 *   pass its Fly checks before the next is updated, so a group of serving
 *   Machines rolls one at a time.
 * - {@link flyMachineExec}: run a command inside the Machine (a migration).
 * - {@link flyMachineRestart}, {@link flyMachineStop}: under a lease, then
 *   wait for the Machine to settle.
 * - {@link flyMachineVerify}: the Machine is started with this release in its
 *   metadata, and, given a URL, its health endpoint answers. With `checks`,
 *   its Fly checks pass too.
 * - {@link flyMachineChecks}: the Machine is started and its Fly checks pass.
 * - {@link flyMachineRestore}: put a recorded Machine config back (restore on
 *   a failed release, and rollback).
 *
 * Every activity takes the flaps endpoint and token the way `flyApply` does
 * (`FLY_FLAPS_BASE_URL`, `FLY_API_TOKEN`), so the same code reaches mudflaps
 * or a real Fly org, and an injectable `http` for tests (./machines-fake.ts).
 */

import {
  appNameFromRequest,
  defaultFlyHttp,
  flyApply,
  isAppRequest,
  isMachineRequest,
  listMachines,
  machineAppSegment,
  resolveApp,
  resolveEndpoint,
  skipsLaunch,
  waitForMachine,
  waitForUnlaunched,
  withLease,
  LEASE_NONCE_HEADER,
  type AppliedMachine,
  type ApplyCtx,
  type FlapsMachine,
  type FlapsRequest,
  type FlyHttp,
  type FlyPlan,
  type WaitOpts,
} from "./fly-apply";
import { parsePlan } from "./fly-apply";
import { readFileSync } from "node:fs";
import { readMachineRelease, withReleaseMetadata, type MachineConfig, type MachineRelease } from "../../release-metadata";

export { RELEASE_METADATA_KEYS, readMachineRelease, withReleaseMetadata } from "../../release-metadata";
export type { MachineRelease } from "../../release-metadata";

/** The App and Machine a release targets in a plan. */
export interface ReleaseTarget {
  app: string;
  /** The plan entity that declares the Machine. */
  entity: string;
  /** The Machine's name on Fly (its `name`, else the entity name). */
  name: string;
  request: FlapsRequest;
}

/** Every Machine the plan declares, with its App resolved. Pure. */
export function planMachines(plan: FlyPlan): ReleaseTarget[] {
  const appNames = Object.values(plan).filter(isAppRequest).map(appNameFromRequest);
  const soleApp = appNames.length === 1 ? appNames[0] : undefined;
  return Object.entries(plan)
    .filter(([, req]) => isMachineRequest(req))
    .map(([entity, request]) => ({
      app: resolveApp(machineAppSegment(request.endpoint), soleApp),
      entity,
      request,
      name: typeof request.body.name === "string" && request.body.name ? request.body.name : entity,
    }));
}

/**
 * The Machine a release targets: the plan's one Machine, or the one `machine`
 * names (an entity name or a Machine name). Pure.
 */
export function releaseTarget(plan: FlyPlan, machine?: string): ReleaseTarget {
  const machines = planMachines(plan);
  const picked = machine ? machines.filter((m) => m.entity === machine || m.name === machine) : machines;
  if (picked.length !== 1) {
    throw new Error(
      machine
        ? `the fly plan declares no Machine named "${machine}" (declared: ${machines.map((m) => m.entity).join(", ") || "none"})`
        : `the fly plan declares ${machines.length} Machines (${machines.map((m) => m.entity).join(", ")}): name the one that serves the release`,
    );
  }
  return picked[0];
}

const TERMINAL = new Set(["destroyed", "destroying"]);

/** The live Machine named `name` (or with id `name`) in `app`; undefined when there is none. */
export async function findMachine(
  ctx: ApplyCtx,
  app: string,
  name: string,
  http: FlyHttp,
  signal?: AbortSignal,
): Promise<FlapsMachine | undefined> {
  const live = (await listMachines(ctx, app, http, signal)).filter((m) => !TERMINAL.has(m.state));
  return live.find((m) => m.name === name) ?? live.find((m) => m.id === name);
}

async function mustFindMachine(ctx: ApplyCtx, app: string, name: string, http: FlyHttp, signal?: AbortSignal): Promise<FlapsMachine> {
  const m = await findMachine(ctx, app, name, http, signal);
  if (!m) throw new Error(`no machine ${name} on app ${app}`);
  return m;
}

const machinePath = (ctx: ApplyCtx, app: string, id: string) =>
  `${ctx.base}/v1/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}`;

// ── Fly checks (#4719) ─────────────────────────────────────────────────────────

/** How long a Machine's Fly checks have to pass, and how often to look. */
export interface MachineChecksOpts {
  /** How long to wait for every check to pass. Default {@link DEFAULT_CHECKS_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Delay between looks. Default 1s. */
  intervalMs?: number;
}

/** Five minutes, as `fly deploy`'s `--wait-timeout`. */
export const DEFAULT_CHECKS_TIMEOUT_MS = 300_000;

/**
 * True when a Machine config declares a Fly check: one under `checks`, or
 * one on any of its `services`. Pure.
 */
export function declaresChecks(config: unknown): boolean {
  const c = (config ?? {}) as { checks?: unknown; services?: unknown };
  if (c.checks && typeof c.checks === "object" && Object.keys(c.checks).length > 0) return true;
  const services = Array.isArray(c.services) ? (c.services as Array<{ checks?: unknown }>) : [];
  return services.some((svc) => Array.isArray(svc?.checks) && svc.checks.length > 0);
}

/**
 * Why a Machine's Fly checks are not all passing, or undefined when they are
 * or it has none. A Machine whose config declares checks that have not
 * reported yet is not passing. Pure.
 */
export function checksPending(m: Pick<FlapsMachine, "config" | "checks">): string | undefined {
  const checks = m.checks ?? [];
  if (checks.length === 0) return declaresChecks(m.config) ? "no check has reported yet" : undefined;
  const failing = checks.filter((c) => c.status !== "passing");
  if (failing.length === 0) return undefined;
  return failing
    .map((c) => {
      const output = (c.output ?? "").trim().slice(0, 200);
      return `check ${c.name} is ${c.status || "unknown"}${output ? ` (${output})` : ""}`;
    })
    .join("; ");
}

/** Where to reach flaps, as every activity here takes it. */
export interface FlapsTarget {
  /** flaps endpoint override. Default: `FLY_FLAPS_BASE_URL`, else real Fly. */
  endpoint?: string;
  /** Bearer token for real Fly. Default: `FLY_API_TOKEN`. */
  token?: string;
}

// ── flyMachineRelease ─────────────────────────────────────────────────────────

export interface FlyMachineReleaseArgs extends FlapsTarget {
  /** Path to the fly build output (`chant build --lexicon fly -o <path>`). */
  planPath?: string;
  /** The plan itself, in place of `planPath`. */
  plan?: FlyPlan;
  /** The Machine that serves the release, when the plan declares more than one. */
  machine?: string;
  /** The release to serve. `previousDigest` is filled in from the Machine it replaces. */
  release: MachineRelease;
  /** An image to run in place of the declared one (a digest-pinned image a publish step produced). */
  image?: string;
  /** Env to add to the declared Machine's env. */
  env?: Record<string, string>;
  /**
   * Files the release puts on the Machine, added to the declared ones: a
   * source release's tree (#2782). A declared file at the same path is
   * replaced.
   */
  files?: MachineFile[];
  /** The command the Machine starts, in place of the image's: an argv, or a string run with `sh -c`. */
  cmd?: string[] | string;
  /**
   * Images for the plan's other Machines, by entity or Machine name (#4696):
   * a scheduled Machine beside the one that serves, say, built from the same
   * commit. A name that is no other Machine in the plan is refused.
   */
  images?: Record<string, string>;
  wait?: WaitOpts;
  /**
   * Wait for each Machine the apply starts to pass its Fly checks before the
   * next is updated (#4719). A Machine with no checks is done once started,
   * and a scheduled one is not waited for. Without it, only `started` is
   * waited for.
   */
  checks?: MachineChecksOpts;
}

/** One Machine a release applied, in the order it was applied. */
export interface ReleasedMachine {
  app: string;
  name: string;
  id: string;
  action: "created" | "updated" | "noop";
  /** True when it was left unstarted (a scheduled Machine, #4696). */
  unlaunched: boolean;
  /** Its config before the release, or null when the release created it. */
  previous: MachineConfig | null;
  /** True for the Machine that serves the release (`machine`). */
  serving: boolean;
}

/**
 * A release that failed partway through its apply (#4719): a Machine that
 * did not settle or whose checks did not pass. `applied` holds the Machines
 * it applied before the failure, the failing one included when its update
 * went through, so the caller can put each back.
 */
export class MachineReleaseError extends Error {
  readonly applied: ReleasedMachine[];
  /** The failure itself. */
  readonly reason: unknown;
  constructor(reason: unknown, applied: ReleasedMachine[]) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "MachineReleaseError";
    this.applied = applied;
    this.reason = reason;
  }
}

/** One file a Machine's config carries, as the Machines API takes it. */
export interface MachineFile {
  guest_path: string;
  /** The file's bytes, base64. */
  raw_value: string;
  /** Unix mode, such as 0o755 for an executable. */
  mode?: number;
}

export interface FlyMachineReleaseResult {
  app: string;
  machine: { id: string; name: string };
  /** What the apply did to the Machine. */
  action: "created" | "updated" | "noop";
  /** The release the Machine serves now. */
  release: MachineRelease;
  /** The Machine config applied: what a later rollback to this release puts back. */
  config: MachineConfig;
  /** What the Machine served before, when it existed: its release (if it named one) and its config. */
  previous: { release?: MachineRelease; config: MachineConfig } | null;
  /** True when the Machine was left unstarted: a scheduled Machine, which runs on its schedule (#4696). */
  unlaunched: boolean;
  /**
   * The plan's other Machines: what the apply did to each, whether it was
   * left unstarted, and the config it had before (null when it was created).
   */
  others: Array<{ name: string; app: string; action: "created" | "updated" | "noop"; unlaunched: boolean; previous: MachineConfig | null }>;
  /** Every Machine in the plan, the serving one included, in the order the apply reached them (#4719). */
  applied: ReleasedMachine[];
}

/**
 * Upload and start: apply the declared plan (the App, its Volumes, IPs,
 * Secrets) with the Machine serving `release`. The Machine is updated in place
 * under a lease, so the release serves from here on. A Machine that already
 * serves this release keeps the `previousDigest` it shipped with, so running a
 * release twice never makes it its own predecessor.
 *
 * A scheduled Machine (its config has a `schedule`, #4696), the target or
 * another in the plan, is created or updated with `skip_launch` and left
 * unstarted: Fly starts it on its schedule. Fly counts the interval from the
 * update, so each release pushes the next run back by up to one interval.
 *
 * Given `checks` (#4719), each Machine the apply starts must pass its Fly
 * checks before the next one is updated. A failure partway through throws a
 * {@link MachineReleaseError} naming the Machines applied so far.
 */
export async function flyMachineRelease(
  args: FlyMachineReleaseArgs,
  signal?: AbortSignal,
  http: FlyHttp = defaultFlyHttp(args.token),
): Promise<FlyMachineReleaseResult> {
  const plan = args.plan ?? parsePlan(readFileSync(requirePlanPath(args.planPath), "utf8"));
  const target = releaseTarget(plan, args.machine);
  const ctx: ApplyCtx = { base: resolveEndpoint(args) };

  const live = await findMachine(ctx, target.app, target.name, http, signal).catch(() => undefined);
  const liveConfig = live?.config as MachineConfig | undefined;
  const liveRelease = readMachineRelease(liveConfig?.metadata);
  const previousDigest =
    liveRelease && liveRelease.digest !== args.release.digest ? liveRelease.digest : liveRelease?.previousDigest ?? args.release.previousDigest;
  const release: MachineRelease = { ...args.release, ...(previousDigest ? { previousDigest } : {}) };
  if (!previousDigest) delete release.previousDigest;

  const declared = (target.request.body.config ?? {}) as MachineConfig;
  const declaredFiles = (declared.files as MachineFile[] | undefined) ?? [];
  const releasePaths = new Set((args.files ?? []).map((f) => f.guest_path));
  const cmd = typeof args.cmd === "string" ? ["sh", "-c", args.cmd] : args.cmd;
  const config = withReleaseMetadata(
    {
      ...declared,
      ...(args.image ? { image: args.image } : {}),
      ...(args.env ? { env: { ...(declared.env ?? {}), ...args.env } } : {}),
      ...(args.files ? { files: [...declaredFiles.filter((f) => !releasePaths.has(f.guest_path)), ...args.files] } : {}),
      ...(cmd ? { init: { ...((declared.init as Record<string, unknown> | undefined) ?? {}), cmd } } : {}),
    },
    release,
  );
  const request: FlapsRequest = { ...target.request, body: { ...target.request.body, config } };

  // The plan's other Machines, each with its own image when `images` names it.
  const others = planMachines(plan).filter((m) => m.entity !== target.entity);
  const images = { ...(args.images ?? {}) };
  const overrides: FlyPlan = {};
  for (const m of others) {
    const image = images[m.entity] ?? images[m.name];
    delete images[m.entity];
    delete images[m.name];
    if (image === undefined) continue;
    const declaredOther = (m.request.body.config ?? {}) as MachineConfig;
    overrides[m.entity] = { ...m.request, body: { ...m.request.body, config: { ...declaredOther, image } } };
  }
  const unknown = Object.keys(images);
  if (unknown.length > 0) {
    throw new Error(
      `images names ${unknown.map((n) => `"${n}"`).join(", ")}, which the fly plan declares as no Machine other than the one that serves (others: ${others.map((m) => m.entity).join(", ") || "none"}); the serving Machine's image is \`image\``,
    );
  }
  const before = new Map<string, MachineConfig | null>();
  for (const m of others) {
    const found = await findMachine(ctx, m.app, m.name, http, signal).catch(() => undefined);
    before.set(m.entity, found ? ((found.config as MachineConfig | undefined) ?? {}) : null);
  }

  const rolled: ReleasedMachine[] = [];
  const afterMachine = async (m: AppliedMachine) => {
    const serving = m.entity === target.entity;
    const previous = serving ? (live ? (liveConfig ?? {}) : null) : (before.get(m.entity) ?? null);
    rolled.push({ app: m.app, name: m.name, id: m.id, action: m.action, unlaunched: m.unlaunched, previous, serving });
    if (args.checks && m.action !== "noop" && !m.unlaunched) {
      await waitForChecks(ctx, m.app, m.name, http, signal, args.checks);
    }
  };
  let applied: Awaited<ReturnType<typeof flyApply>>;
  try {
    applied = await flyApply(
      { plan: { ...plan, ...overrides, [target.entity]: request }, endpoint: args.endpoint, token: args.token, wait: args.wait, afterMachine },
      signal,
      http,
    );
  } catch (err) {
    throw new MachineReleaseError(err, rolled);
  }
  const actionOf = (app: string, name: string) => applied.machines.find((m) => m.app === app && m.name === name)?.action ?? "noop";
  const now = await mustFindMachine(ctx, target.app, target.name, http, signal);
  return {
    app: target.app,
    machine: { id: now.id, name: target.name },
    action: actionOf(target.app, target.name),
    release,
    config,
    previous: live ? { ...(liveRelease ? { release: liveRelease } : {}), config: liveConfig ?? {} } : null,
    unlaunched: skipsLaunch(request.body),
    others: others.map((m) => ({
      name: m.name,
      app: m.app,
      action: actionOf(m.app, m.name),
      unlaunched: skipsLaunch((overrides[m.entity] ?? m.request).body),
      previous: before.get(m.entity) ?? null,
    })),
    applied: rolled,
  };
}

function requirePlanPath(planPath: string | undefined): string {
  if (!planPath) throw new Error("pass planPath (the fly build output) or plan");
  return planPath;
}

// ── flyMachineExec ────────────────────────────────────────────────────────────

export interface FlyMachineExecArgs extends FlapsTarget {
  app: string;
  /** The Machine's name or id. */
  machine: string;
  /** The command: an argv, or a string run with `sh -c`. */
  command: string[] | string;
  /** Seconds the Machines API lets the command run. Default 120. */
  timeoutSecs?: number;
}

export interface FlyMachineExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command inside the Machine (the Machines API's exec). A non-zero exit
 * throws, with the command's output, so the step fails rather than going on
 * over a half-migrated database.
 */
export async function flyMachineExec(
  args: FlyMachineExecArgs,
  signal?: AbortSignal,
  http: FlyHttp = defaultFlyHttp(args.token),
): Promise<FlyMachineExecResult> {
  const ctx: ApplyCtx = { base: resolveEndpoint(args) };
  const m = await mustFindMachine(ctx, args.app, args.machine, http, signal);
  const command = typeof args.command === "string" ? ["sh", "-c", args.command] : args.command;
  const res = await http("POST", `${machinePath(ctx, args.app, m.id)}/exec`, { command, timeout: args.timeoutSecs ?? 120 }, undefined, signal);
  if (res.status >= 300) throw new Error(`exec on ${args.app}/${m.id} failed (${res.status}): ${res.text}`);
  let out: { exit_code?: number; stdout?: string; stderr?: string } = {};
  try {
    out = JSON.parse(res.text) as typeof out;
  } catch {
    throw new Error(`exec on ${args.app}/${m.id} answered no exec result: ${res.text}`);
  }
  const result = { exitCode: out.exit_code ?? 0, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
  if (result.exitCode !== 0) {
    const said = [result.stderr, result.stdout].filter(Boolean).join("\n").trim().slice(-2000);
    throw new Error(`${command.join(" ")} exited ${result.exitCode} on ${args.app}/${m.id}${said ? `: ${said}` : ""}`);
  }
  return result;
}

// ── flyMachineRestart / flyMachineStop ────────────────────────────────────────

export interface FlyMachineStateArgs extends FlapsTarget {
  app: string;
  /** The Machine's name or id. */
  machine: string;
  wait?: WaitOpts;
}

async function transition(
  args: FlyMachineStateArgs,
  verb: "restart" | "stop",
  signal: AbortSignal | undefined,
  http: FlyHttp,
): Promise<{ id: string; state: string }> {
  const ctx: ApplyCtx = { base: resolveEndpoint(args) };
  const m = await mustFindMachine(ctx, args.app, args.machine, http, signal);
  const state = verb === "stop" ? "stopped" : "started";
  if (verb === "stop" && m.state !== "started") return { id: m.id, state: m.state };
  const res = await withLease(ctx, args.app, m.id, http, signal, (nonce) =>
    http("POST", `${machinePath(ctx, args.app, m.id)}/${verb}`, undefined, { [LEASE_NONCE_HEADER]: nonce }, signal),
  );
  if (res.status >= 300) throw new Error(`${verb} of machine ${args.app}/${m.id} failed (${res.status}): ${res.text}`);
  await waitForMachine(ctx, args.app, m.id, "", http, signal, { ...(args.wait ?? {}), state });
  return { id: m.id, state };
}

/** Restart the Machine under a lease (the app starts again on migrated data), and wait for it to be started. */
export async function flyMachineRestart(
  args: FlyMachineStateArgs,
  signal?: AbortSignal,
  http: FlyHttp = defaultFlyHttp(args.token),
): Promise<{ id: string; state: string }> {
  return transition(args, "restart", signal, http);
}

/** Stop the Machine under a lease, and wait for it to be stopped. A Machine that is not started is left alone. */
export async function flyMachineStop(
  args: FlyMachineStateArgs,
  signal?: AbortSignal,
  http: FlyHttp = defaultFlyHttp(args.token),
): Promise<{ id: string; state: string }> {
  return transition(args, "stop", signal, http);
}

// ── flyMachineVerify ──────────────────────────────────────────────────────────

export interface FlyMachineVerifyArgs extends FlapsTarget {
  app: string;
  machine: string;
  /** The release digest the Machine must name. */
  digest: string;
  /** The app's public URL; with it, its health endpoint must answer. */
  url?: string;
  /** Path of the health endpoint under `url`. Default `/health`. */
  healthPath?: string;
  /** How long to keep asking. Default 120s. */
  timeoutMs?: number;
  /** Delay between asks. Default 1s. */
  intervalMs?: number;
  /** The Machine's Fly checks must all pass too (#4719). A Machine with none passes on its state alone. */
  checks?: boolean;
}

/**
 * The Machine is started and its metadata names release `digest`. A scheduled
 * Machine (#4696) may also be resting unstarted (`created`, `stopped` or
 * `suspended`) between runs. Given a `url`, its health endpoint answers 2xx too, and when that answer is JSON
 * naming a `revision` or `digest`, it is this release's (the commit or the
 * digest). Retries until `timeoutMs`, then throws the last reason.
 */
export async function flyMachineVerify(
  args: FlyMachineVerifyArgs,
  signal?: AbortSignal,
  http: FlyHttp = defaultFlyHttp(args.token),
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; release: MachineRelease }> {
  const ctx: ApplyCtx = { base: resolveEndpoint(args) };
  const deadline = Date.now() + (args.timeoutMs ?? 120_000);
  const interval = args.intervalMs ?? 1_000;
  let why = "";
  for (;;) {
    if (signal?.aborted) throw new Error("flyMachineVerify aborted");
    try {
      const m = await mustFindMachine(ctx, args.app, args.machine, http, signal);
      const scheduled = skipsLaunch({ config: m.config });
      const resting = scheduled && ["created", "stopped", "suspended"].includes(m.state);
      if (m.state !== "started" && !resting) throw new Error(`machine ${args.app}/${m.id} is ${m.state}`);
      const release = readMachineRelease(m.config?.metadata);
      if (release?.digest !== args.digest) {
        throw new Error(`machine ${args.app}/${m.id} serves ${release?.digest ?? "no release"}, expected ${args.digest}`);
      }
      if (args.checks && m.state === "started") {
        const pending = checksPending(m);
        if (pending) throw new Error(`machine ${args.app}/${args.machine} (${m.id}): ${pending}`);
      }
      if (args.url) {
        const url = `${args.url.replace(/\/$/, "")}${args.healthPath ?? "/health"}`;
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) throw new Error(`${url} answered ${res.status}`);
        let body: { revision?: unknown; digest?: unknown } | undefined;
        try {
          body = (await res.json()) as typeof body;
        } catch {
          body = undefined;
        }
        const reported = typeof body?.revision === "string" ? body.revision : typeof body?.digest === "string" ? body.digest : undefined;
        if (reported !== undefined && reported !== release.gitSha && reported !== release.digest) {
          throw new Error(`${url} reports ${reported}, expected ${release.gitSha ?? release.digest}`);
        }
      }
      return { id: m.id, release };
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() + interval > deadline) throw new Error(`verify ${args.app}/${args.machine}: ${why}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// ── flyMachineRestore ─────────────────────────────────────────────────────────

export interface FlyMachineRestoreArgs extends FlapsTarget {
  app: string;
  machine: string;
  /** The Machine config to put back, as a release applied it (its metadata names that release). */
  config: MachineConfig;
  wait?: WaitOpts;
  /** Once it is started again, wait for its Fly checks to pass too (#4719). */
  checks?: MachineChecksOpts;
}

/**
 * Put a recorded Machine config back: update the Machine to exactly `config`
 * under a lease and wait for it to be started. Used on a failed release (the
 * config it replaced) and by a rollback (the config an earlier release applied).
 * A scheduled config (#4696) goes back with `skip_launch`, and the wait is for
 * the Machine to rest unstarted.
 */
export async function flyMachineRestore(
  args: FlyMachineRestoreArgs,
  signal?: AbortSignal,
  http: FlyHttp = defaultFlyHttp(args.token),
): Promise<{ id: string; release?: MachineRelease }> {
  const ctx: ApplyCtx = { base: resolveEndpoint(args) };
  const m = await mustFindMachine(ctx, args.app, args.machine, http, signal);
  const unlaunched = skipsLaunch({ config: args.config });
  const body = { name: m.name, config: args.config, ...(unlaunched ? { skip_launch: true } : {}) };
  const res = await withLease(ctx, args.app, m.id, http, signal, (nonce) =>
    http("POST", machinePath(ctx, args.app, m.id), body, { [LEASE_NONCE_HEADER]: nonce }, signal),
  );
  if (res.status >= 300) throw new Error(`restore of machine ${args.app}/${m.id} failed (${res.status}): ${res.text}`);
  let instance = "";
  try {
    instance = (JSON.parse(res.text) as { instance_id?: string }).instance_id ?? "";
  } catch {
    instance = "";
  }
  if (unlaunched) await waitForUnlaunched(ctx, args.app, m.id, instance, http, signal, args.wait ?? {});
  else {
    await waitForMachine(ctx, args.app, m.id, instance, http, signal, args.wait ?? {});
    if (args.checks) await waitForChecks(ctx, args.app, args.machine, http, signal, args.checks);
  }
  const release = readMachineRelease(args.config.metadata);
  return { id: m.id, ...(release ? { release } : {}) };
}

// ── flyMachineChecks (#4719) ──────────────────────────────────────────────────

export interface FlyMachineChecksArgs extends FlapsTarget, MachineChecksOpts {
  app: string;
  /** The Machine's name or id. */
  machine: string;
}

/**
 * Wait until the Machine is started and every one of its Fly checks
 * (`checks[].status` on the Machine) is `passing`. A Machine with no checks
 * is done once started. Throws after `timeoutMs`, naming the Machine and each
 * check that is not passing.
 */
export async function flyMachineChecks(
  args: FlyMachineChecksArgs,
  signal?: AbortSignal,
  http: FlyHttp = defaultFlyHttp(args.token),
): Promise<{ id: string }> {
  return waitForChecks({ base: resolveEndpoint(args) }, args.app, args.machine, http, signal, args);
}

async function waitForChecks(
  ctx: ApplyCtx,
  app: string,
  name: string,
  http: FlyHttp,
  signal: AbortSignal | undefined,
  opts: MachineChecksOpts,
): Promise<{ id: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECKS_TIMEOUT_MS;
  const interval = opts.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new Error(`waiting for the checks of ${app}/${name} aborted`);
    const m = await mustFindMachine(ctx, app, name, http, signal);
    const why = m.state === "started" ? checksPending(m) : `it is ${m.state}`;
    if (!why) return { id: m.id };
    if (Date.now() + interval > deadline) {
      throw new Error(`machine ${app}/${name} (${m.id}) did not pass its Fly checks within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`}: ${why}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
