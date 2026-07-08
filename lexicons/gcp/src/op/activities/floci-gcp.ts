import { exec } from "node:child_process";
import { promisify } from "node:util";
import { safeHeartbeat, sleep } from "@intentius/chant/op";

const execAsync = promisify(exec);

const DEFAULT_NAME = "chant-floci-gcp";
const DEFAULT_PORT = 4588;
const DEFAULT_IMAGE = "floci/floci-gcp:latest";

export interface FlociGcpUpArgs {
  /** Container name. Default: `chant-floci-gcp`. */
  name?: string;
  /** Host port mapped to the emulator's `:4588`. Default: `4588`. */
  port?: number;
  /** Image. Default: `floci/floci-gcp:latest`. */
  image?: string;
  /** Readiness timeout in ms. Default: `60000`. */
  timeoutMs?: number;
  /** Health poll interval in ms. Default: `2000`. */
  intervalMs?: number;
}

export interface FlociGcpDownArgs {
  /** Container name to remove. Default: `chant-floci-gcp`. */
  name?: string;
}

/** `docker ps -q -f name=<name>` — non-empty stdout means the container is running. */
export function flociGcpExistsCommand(name: string): string {
  return `docker ps -q -f name=${name}`;
}

/** Build the `docker run` command that boots floci-gcp. */
export function flociGcpRunCommand(args: FlociGcpUpArgs): string {
  const name = args.name ?? DEFAULT_NAME;
  const port = args.port ?? DEFAULT_PORT;
  const image = args.image ?? DEFAULT_IMAGE;
  return ["docker", "run", "-d", "--rm", "--name", name, "-p", `${port}:4588`, image].join(" ");
}

/** Build the `docker rm -f` command. */
export function flociGcpRmCommand(name: string): string {
  return `docker rm -f ${name}`;
}

/** The floci-gcp health endpoint URL for a host port. */
export function flociGcpHealthUrl(port: number): string {
  return `http://localhost:${port}/_floci-gcp/health`;
}

/** The GCP endpoint URL (what `gcpApply`'s `endpoint` should point at). */
export function flociGcpEndpoint(port: number): string {
  return `http://localhost:${port}`;
}

/**
 * Boot a local floci-gcp (GCP emulator) in Docker and return its endpoint.
 *
 * Idempotent: reuses a running container of the same name. Waits for the health
 * endpoint to answer, then returns `{ endpoint }` for `gcpApply({ endpoint })`.
 * The typed twin of the AWS `flociUp` — replaces a raw `docker run` shell step so
 * the emulator lifecycle is modeled, not scripted. Uses longInfra profile — 20m
 * timeout, heartbeat every poll (the image may pull).
 */
export async function flociGcpUp(args: FlociGcpUpArgs, signal?: AbortSignal): Promise<{ endpoint: string }> {
  const name = args.name ?? DEFAULT_NAME;
  const port = args.port ?? DEFAULT_PORT;
  const timeoutMs = args.timeoutMs ?? 60_000;
  const intervalMs = args.intervalMs ?? 2_000;

  let running = false;
  try {
    const { stdout } = await execAsync(flociGcpExistsCommand(name), { signal });
    running = Boolean(stdout.trim());
  } catch {
    // `docker ps` failed — assume not running and try to start it.
  }

  if (running) {
    console.log(`floci-gcp container "${name}" already running — reusing`);
  } else {
    await execAsync(flociGcpRunCommand({ ...args, name, port }), { signal });
  }

  const url = flociGcpHealthUrl(port);
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("flociGcpUp aborted");
    safeHeartbeat({ step: "flociGcpUp", container: name });
    try {
      const res = await fetch(url, { signal });
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // Not up yet (connection refused / non-2xx) — retry.
    }
    await sleep(intervalMs, signal);
  }
  if (!ready) {
    throw new Error(`floci-gcp "${name}" did not become ready within ${timeoutMs}ms`);
  }

  const endpoint = flociGcpEndpoint(port);
  console.log(`floci-gcp ready on ${endpoint}`);
  return { endpoint };
}

/**
 * Stop and remove the local floci-gcp container. A no-op success when the
 * container is already gone. Uses fastIdempotent profile — 5m timeout.
 */
export async function flociGcpDown(args: FlociGcpDownArgs, signal?: AbortSignal): Promise<void> {
  const name = args.name ?? DEFAULT_NAME;
  try {
    await execAsync(flociGcpRmCommand(name), { signal });
  } catch {
    // Already removed (`--rm` on exit, or never started) — treat as success.
  }
}
