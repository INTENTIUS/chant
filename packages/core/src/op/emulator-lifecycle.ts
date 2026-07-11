import { exec } from "node:child_process";
import { promisify } from "node:util";
import { safeHeartbeat, sleep } from "./activity-runtime";

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
  /** Health path on the host port (e.g. `/_localstack/health`, `/_mudflaps/health`). */
  healthPath: string;
  /** Readiness predicate over the health body. Default: any 200 response is ready. */
  ready?: (healthBody: string) => boolean;
  /** Extra `docker run` args inserted before the image (e.g. a socket mount). */
  runArgs?: readonly string[];
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
  const healthUrl = (port: number): string => `http://localhost:${port}${spec.healthPath}`;
  const endpoint = (port: number): string => `http://localhost:${port}`;

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
      console.log(`emulator container "${name}" already running — reusing`);
    } else {
      await execAsync(runCommand({ ...args, name, port }), { signal });
    }

    const url = healthUrl(port);
    const deadline = Date.now() + timeoutMs;
    let ok = false;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error(`emulator "${name}" wait aborted`);
      safeHeartbeat({ step: "emulatorUp", container: name });
      try {
        const res = await fetch(url, { signal });
        if (res.ok && ready(await res.text())) {
          ok = true;
          break;
        }
      } catch {
        // Not up yet (connection refused / non-2xx) — retry.
      }
      await sleep(intervalMs, signal);
    }
    if (!ok) {
      throw new Error(`emulator "${name}" did not become ready within ${timeoutMs}ms`);
    }

    const ep = endpoint(port);
    console.log(`emulator "${name}" ready on ${ep}`);
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

  return { runCommand, existsCommand, rmCommand, healthUrl, endpoint, up, down };
}
