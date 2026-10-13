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
 *   release says so), and report the release and config it replaced.
 * - {@link flyMachineExec}: run a command inside the Machine (a migration).
 * - {@link flyMachineRestart}, {@link flyMachineStop}: under a lease, then
 *   wait for the Machine to settle.
 * - {@link flyMachineVerify}: the Machine is started with this release in its
 *   metadata, and, given a URL, its health endpoint answers.
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
  waitForMachine,
  withLease,
  LEASE_NONCE_HEADER,
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

/**
 * The Machine a release targets: the plan's one Machine, or the one `machine`
 * names (an entity name or a Machine name). Pure.
 */
export function releaseTarget(plan: FlyPlan, machine?: string): ReleaseTarget {
  const appNames = Object.values(plan).filter(isAppRequest).map(appNameFromRequest);
  const soleApp = appNames.length === 1 ? appNames[0] : undefined;
  const machines = Object.entries(plan)
    .filter(([, req]) => isMachineRequest(req))
    .map(([entity, request]) => ({
      entity,
      request,
      name: typeof request.body.name === "string" && request.body.name ? request.body.name : entity,
    }));
  const picked = machine ? machines.filter((m) => m.entity === machine || m.name === machine) : machines;
  if (picked.length !== 1) {
    throw new Error(
      machine
        ? `the fly plan declares no Machine named "${machine}" (declared: ${machines.map((m) => m.entity).join(", ") || "none"})`
        : `the fly plan declares ${machines.length} Machines (${machines.map((m) => m.entity).join(", ")}): name the one that serves the release`,
    );
  }
  const [m] = picked;
  return { app: resolveApp(machineAppSegment(m.request.endpoint), soleApp), entity: m.entity, name: m.name, request: m.request };
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
  wait?: WaitOpts;
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
}

/**
 * Upload and start: apply the declared plan (the App, its Volumes, IPs,
 * Secrets) with the Machine serving `release`. The Machine is updated in place
 * under a lease, so the release serves from here on. A Machine that already
 * serves this release keeps the `previousDigest` it shipped with, so running a
 * release twice never makes it its own predecessor.
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
  const applied = await flyApply(
    { plan: { ...plan, [target.entity]: request }, endpoint: args.endpoint, token: args.token, wait: args.wait },
    signal,
    http,
  );
  const action = applied.machines.find((m) => m.app === target.app && m.name === target.name)?.action ?? "noop";
  const now = await mustFindMachine(ctx, target.app, target.name, http, signal);
  return {
    app: target.app,
    machine: { id: now.id, name: target.name },
    action,
    release,
    config,
    previous: live ? { ...(liveRelease ? { release: liveRelease } : {}), config: liveConfig ?? {} } : null,
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
}

/**
 * The Machine is started and its metadata names release `digest`. Given a
 * `url`, its health endpoint answers 2xx too, and when that answer is JSON
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
      if (m.state !== "started") throw new Error(`machine ${args.app}/${m.id} is ${m.state}`);
      const release = readMachineRelease(m.config?.metadata);
      if (release?.digest !== args.digest) {
        throw new Error(`machine ${args.app}/${m.id} serves ${release?.digest ?? "no release"}, expected ${args.digest}`);
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
}

/**
 * Put a recorded Machine config back: update the Machine to exactly `config`
 * under a lease and wait for it to be started. Used on a failed release (the
 * config it replaced) and by a rollback (the config an earlier release applied).
 */
export async function flyMachineRestore(
  args: FlyMachineRestoreArgs,
  signal?: AbortSignal,
  http: FlyHttp = defaultFlyHttp(args.token),
): Promise<{ id: string; release?: MachineRelease }> {
  const ctx: ApplyCtx = { base: resolveEndpoint(args) };
  const m = await mustFindMachine(ctx, args.app, args.machine, http, signal);
  const res = await withLease(ctx, args.app, m.id, http, signal, (nonce) =>
    http("POST", machinePath(ctx, args.app, m.id), { name: m.name, config: args.config }, { [LEASE_NONCE_HEADER]: nonce }, signal),
  );
  if (res.status >= 300) throw new Error(`restore of machine ${args.app}/${m.id} failed (${res.status}): ${res.text}`);
  let instance = "";
  try {
    instance = (JSON.parse(res.text) as { instance_id?: string }).instance_id ?? "";
  } catch {
    instance = "";
  }
  await waitForMachine(ctx, args.app, m.id, instance, http, signal, args.wait ?? {});
  const release = readMachineRelease(args.config.metadata);
  return { id: m.id, ...(release ? { release } : {}) };
}
