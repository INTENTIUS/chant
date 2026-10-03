import { exec } from "node:child_process";
import { promisify } from "node:util";
import { sleep } from "./activity-runtime";

const execAsync = promisify(exec);

/**
 * A local emulator's fixed identity — everything that differs between the
 * per-cloud Docker-lifecycle wrappers (Floci for AWS, floci-az/gcp, mudflaps for
 * Fly). Only these five things vary; the boot/health-poll/teardown loop is shared.
 */
export interface EmulatorSpec {
  /** Default container name (e.g. `chant-floci`, `chant-mudflaps`). */
  name: string;
  /** Default image, ideally a pinned tag. */
  image: string;
  /** Port the emulator listens on inside the container (e.g. 4566, 4280). */
  containerPort: number;
  /**
   * Health path on the host port (e.g. `/_localstack/health`, `/_mudflaps/health`).
   * Required unless {@link readyCommand} is set: an emulator is reached over
   * HTTP or checks itself inside its container, one or the other.
   */
  healthPath?: string;
  /**
   * A command run inside the container (`docker exec <name> ...`) whose exit
   * status 0 means ready, for an emulator with no HTTP health endpoint: a
   * database server answers its own client (`pg_isready`), not a URL. When
   * set, it replaces the HTTP poll of {@link healthPath}.
   */
  readyCommand?: readonly string[];
  /**
   * The endpoint a tool connects to, for an emulator that is not reached over
   * HTTP, e.g. a `postgres://` URL for a database server.
   * Default: `http://localhost:<port>`.
   */
  endpoint?: (port: number) => string;
  /** Readiness predicate over the health body. Default: any 200 response is ready. */
  ready?: (healthBody: string) => boolean;
  /** Extra `docker run` args inserted before the image (e.g. a socket mount). */
  runArgs?: readonly string[];
  /**
   * Where {@link image} is published, so how far behind the pin is can be
   * answered (#1345).
   *
   * fly pinned its two emulators and tracked their freshness; aws, azure and gcp
   * ran `floci/*:latest`, which is the drift a pin exists to stop — a local test
   * suite that passes today and fails tomorrow because an image moved underneath
   * it, with nothing in the repo recording what changed. Declaring the upstream
   * makes the check general instead of one lexicon's private tooling.
   */
  upstream?: {
    /** `owner/repo` whose latest GitHub release names the current version. */
    repo: string;
  };
}

/**
 * A lexicon's local-emulator capability (#920) — what `chant emulator` needs to
 * boot it and point tooling at it. The `spec` drives the Docker lifecycle; `env`
 * returns the variables that redirect the SDK / `chant graph --live` / a triggered
 * Op at the running emulator (e.g. `AWS_ENDPOINT_URL`). `env` is `{}` when the
 * emulator is reached only via an explicit apply argument, not a global variable.
 */
export interface EmulatorCapability {
  spec: EmulatorSpec;
  env(endpoint: string): Record<string, string>;
}

/**
 * What a plugin declares: one emulator, or several (#1345).
 *
 * fly ships two — mudflaps for the Machines API and spritzer for Sprites — and
 * a single-spec field could describe only one of them, so both stayed
 * unreachable from `chant emulator` while the repo's docs presented them as
 * first-class local targets.
 */
export type EmulatorDeclaration = EmulatorCapability | readonly EmulatorCapability[];

/** Every emulator a plugin declares, normalized to a list. */
export function emulatorsOf(declaration: EmulatorDeclaration | undefined): readonly EmulatorCapability[] {
  if (!declaration) return [];
  return Array.isArray(declaration) ? declaration : [declaration as EmulatorCapability];
}

/** Sentinel that cannot collide with a real endpoint or a credential value. */
const ENDPOINT_PROBE = "chant-endpoint-probe://0";

/**
 * The env vars whose value *is* the endpoint, as opposed to the credentials and
 * region an emulator also needs (#1345).
 *
 * Derived by asking `env()` for a sentinel and keeping the keys that carry it,
 * so a lexicon states the mapping once in the place it already states it. The
 * alternative — `LEXICON_ENDPOINT_ENV_VAR`, a hand-maintained map in core — held
 * two of the four lexicons that have one, and its module doc asserted azure had
 * none while `describe-resources.ts` read `AZURE_ENDPOINT_URL` on every call.
 */
export function endpointEnvVars(capability: EmulatorCapability): string[] {
  return Object.entries(capability.env(ENDPOINT_PROBE))
    .filter(([, value]) => value === ENDPOINT_PROBE)
    .map(([key]) => key);
}

/** Per-call overrides for {@link EmulatorLifecycle.up} / `runCommand`. */
export interface EmulatorUpArgs {
  name?: string;
  port?: number;
  image?: string;
  timeoutMs?: number;
  intervalMs?: number;
  /** Additional `docker run` args for this call (after `spec.runArgs`, before the image). */
  extraArgs?: readonly string[];
}

/** The shared lifecycle a per-cloud wrapper adapts. */
export interface EmulatorLifecycle {
  runCommand(args?: EmulatorUpArgs): string;
  existsCommand(name: string): string;
  rmCommand(name: string): string;
  healthUrl(port: number): string;
  /** `docker exec <name> <readyCommand...>`, or undefined for an emulator polled over HTTP. */
  readyExecCommand(name: string): string | undefined;
  endpoint(port: number): string;
  up(args?: EmulatorUpArgs, signal?: AbortSignal): Promise<{ endpoint: string }>;
  down(args?: { name?: string }, signal?: AbortSignal): Promise<void>;
}

/**
 * Build a Docker-lifecycle for a local emulator: an idempotent `up` (reuse a
 * running container, else `docker run`, then poll health until ready), a `down`
 * (`docker rm -f`), and the pure command builders each per-cloud wrapper exposes
 * for testing. Removes the near-duplication across the per-lexicon `floci*.ts`
 * wrappers — a new cloud is a spec, not a copy.
 */
export function emulatorLifecycle(spec: EmulatorSpec): EmulatorLifecycle {
  const ready = spec.ready ?? (() => true);
  if (spec.healthPath === undefined && !spec.readyCommand?.length) {
    throw new Error(`emulator "${spec.name}" declares neither a healthPath nor a readyCommand, so nothing can tell when it is ready`);
  }

  const runCommand = (args: EmulatorUpArgs = {}): string => {
    const name = args.name ?? spec.name;
    const port = args.port ?? spec.containerPort;
    const image = args.image ?? spec.image;
    return [
      "docker", "run", "-d", "--rm", "--name", name, "-p", `${port}:${spec.containerPort}`,
      ...(spec.runArgs ?? []), ...(args.extraArgs ?? []), image,
    ].join(" ");
  };
  const existsCommand = (name: string): string => `docker ps -q -f name=${name}`;
  const rmCommand = (name: string): string => `docker rm -f ${name}`;
  const healthUrl = (port: number): string => `http://localhost:${port}${spec.healthPath ?? ""}`;
  const endpoint = (port: number): string => (spec.endpoint ? spec.endpoint(port) : `http://localhost:${port}`);
  const readyExecCommand = (name: string): string | undefined =>
    spec.readyCommand?.length ? ["docker", "exec", name, ...spec.readyCommand].join(" ") : undefined;

  /** One readiness probe: the in-container command when declared, else the HTTP health path. */
  async function probe(name: string, port: number, signal?: AbortSignal): Promise<boolean> {
    const command = readyExecCommand(name);
    if (command) {
      try {
        await execAsync(command, { signal });
        return true;
      } catch {
        return false;
      }
    }
    try {
      const res = await fetch(healthUrl(port), { signal });
      return res.ok && ready(await res.text());
    } catch {
      // Not up yet (connection refused / non-2xx) — retry.
      return false;
    }
  }

  async function up(args: EmulatorUpArgs = {}, signal?: AbortSignal): Promise<{ endpoint: string }> {
    const name = args.name ?? spec.name;
    const port = args.port ?? spec.containerPort;
    const timeoutMs = args.timeoutMs ?? 60_000;
    const intervalMs = args.intervalMs ?? 2_000;

    let running = false;
    try {
      const { stdout } = await execAsync(existsCommand(name), { signal });
      running = Boolean(stdout.trim());
    } catch {
      // `docker ps` failed — assume not running and try to start it.
    }

    if (running) {
      // Progress → stderr, so a `--json` consumer (chant emulator, behold) reads
      // clean JSON on stdout. runOp/Op activities capture both streams regardless.
      console.error(`emulator container "${name}" already running — reusing`);
    } else {
      await execAsync(runCommand({ ...args, name, port }), { signal });
    }

    const deadline = Date.now() + timeoutMs;
    let ok = false;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error(`emulator "${name}" wait aborted`);
      if (await probe(name, port, signal)) {
        ok = true;
        break;
      }
      await sleep(intervalMs, signal);
    }
    if (!ok) {
      throw new Error(`emulator "${name}" did not become ready within ${timeoutMs}ms`);
    }

    const ep = endpoint(port);
    console.error(`emulator "${name}" ready on ${ep}`);
    return { endpoint: ep };
  }

  async function down(args: { name?: string } = {}, signal?: AbortSignal): Promise<void> {
    const name = args.name ?? spec.name;
    try {
      await execAsync(rmCommand(name), { signal });
    } catch {
      // Already removed (`--rm` on exit, or never started) — treat as success.
    }
  }

  return { runCommand, existsCommand, rmCommand, healthUrl, readyExecCommand, endpoint, up, down };
}
