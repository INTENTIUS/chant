import { exec } from "node:child_process";
import { promisify } from "node:util";
import { safeHeartbeat, sleep } from "@intentius/chant/op";

const execAsync = promisify(exec);

const DEFAULT_NAME = "chant-floci-az";
const DEFAULT_PORT = 4577;
const DEFAULT_IMAGE = "floci/floci-az:latest";

export interface FlociAzUpArgs {
  /** Container name. Default: `chant-floci-az`. */
  name?: string;
  /** Host port mapped to the emulator's `:4577`. Default: `4577`. */
  port?: number;
  /** Image. Default: `floci/floci-az:latest`. */
  image?: string;
  /** Readiness timeout in ms. Default: `60000`. */
  timeoutMs?: number;
  /** Health poll interval in ms. Default: `2000`. */
  intervalMs?: number;
}

export interface FlociAzDownArgs {
  /** Container name to remove. Default: `chant-floci-az`. */
  name?: string;
}

/** `docker ps -q -f name=<name>` — non-empty stdout means the container is running. */
export function flociAzExistsCommand(name: string): string {
  return `docker ps -q -f name=${name}`;
}

/** Build the `docker run` command that boots floci-az. */
export function flociAzRunCommand(args: FlociAzUpArgs): string {
  const name = args.name ?? DEFAULT_NAME;
  const port = args.port ?? DEFAULT_PORT;
  const image = args.image ?? DEFAULT_IMAGE;
  return ["docker", "run", "-d", "--rm", "--name", name, "-p", `${port}:4577`, image].join(" ");
}

/** Build the `docker rm -f` command. */
export function flociAzRmCommand(name: string): string {
  return `docker rm -f ${name}`;
}

/** The floci-az health endpoint URL for a host port. */
export function flociAzHealthUrl(port: number): string {
  return `http://localhost:${port}/_floci/health`;
}

/** The ARM endpoint URL (what `azApply`'s `endpoint` should point at). */
export function flociAzEndpoint(port: number): string {
  return `http://localhost:${port}`;
}

/**
 * Boot a local floci-az (Azure emulator) in Docker and return its ARM endpoint.
 *
 * Idempotent: reuses a running container of the same name. Waits for the health
 * endpoint to answer, then returns `{ endpoint }` for `azApply({ endpoint })`.
 * The typed twin of the AWS `flociUp` — replaces a raw `docker run` shell step so
 * the emulator lifecycle is modeled, not scripted. Uses longInfra profile — 20m
 * timeout, heartbeat every poll (the image may pull).
 */
export async function flociAzUp(args: FlociAzUpArgs, signal?: AbortSignal): Promise<{ endpoint: string }> {
  const name = args.name ?? DEFAULT_NAME;
  const port = args.port ?? DEFAULT_PORT;
  const timeoutMs = args.timeoutMs ?? 60_000;
  const intervalMs = args.intervalMs ?? 2_000;

  let running = false;
  try {
    const { stdout } = await execAsync(flociAzExistsCommand(name), { signal });
    running = Boolean(stdout.trim());
  } catch {
    // `docker ps` failed — assume not running and try to start it.
  }

  if (running) {
    console.log(`floci-az container "${name}" already running — reusing`);
  } else {
    await execAsync(flociAzRunCommand({ ...args, name, port }), { signal });
  }

  const url = flociAzHealthUrl(port);
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("flociAzUp aborted");
    safeHeartbeat({ step: "flociAzUp", container: name });
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
    throw new Error(`floci-az "${name}" did not become ready within ${timeoutMs}ms`);
  }

  const endpoint = flociAzEndpoint(port);
  console.log(`floci-az ready on ${endpoint}`);
  return { endpoint };
}

/**
 * Stop and remove the local floci-az container. A no-op success when the
 * container is already gone. Uses fastIdempotent profile — 5m timeout.
 */
export async function flociAzDown(args: FlociAzDownArgs, signal?: AbortSignal): Promise<void> {
  const name = args.name ?? DEFAULT_NAME;
  try {
    await execAsync(flociAzRmCommand(name), { signal });
  } catch {
    // Already removed (`--rm` on exit, or never started) — treat as success.
  }
}
