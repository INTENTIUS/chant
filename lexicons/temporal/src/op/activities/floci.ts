import { exec } from "node:child_process";
import { promisify } from "node:util";
import { safeHeartbeat } from "./heartbeat";
import { sleep } from "./util";

const execAsync = promisify(exec);

const DEFAULT_NAME = "chant-floci";
const DEFAULT_PORT = 4566;
const DEFAULT_IMAGE = "floci/floci:latest";
const DEFAULT_REGION = "us-east-1";
const DEFAULT_READY_SERVICE = "cloudformation";

export interface FlociUpArgs {
  /** Container name. Default: `chant-floci`. */
  name?: string;
  /** Host port mapped to the emulator's `:4566`. Default: `4566`. */
  port?: number;
  /** Floci image. Default: `floci/floci:latest`. */
  image?: string;
  /** Mount the docker socket — Floci needs it for the ECR backing registry. Default: `false`. */
  dockerSocket?: boolean;
  /** `AWS_REGION` exported for subsequent steps. Default: `us-east-1`. */
  region?: string;
  /** Service to wait for in `/_localstack/health`. Default: `cloudformation`. */
  readyService?: string;
  /** Readiness timeout in ms. Default: `60000`. */
  timeoutMs?: number;
  /** Health poll interval in ms. Default: `2000`. */
  intervalMs?: number;
}

export interface FlociDownArgs {
  /** Container name to remove. Default: `chant-floci`. */
  name?: string;
}

/** `docker ps -q -f name=<name>` — non-empty stdout means the container is running. */
export function flociExistsCommand(name: string): string {
  return `docker ps -q -f name=${name}`;
}

/** Build the `docker run` command that boots Floci. */
export function flociRunCommand(args: FlociUpArgs): string {
  const name = args.name ?? DEFAULT_NAME;
  const port = args.port ?? DEFAULT_PORT;
  const image = args.image ?? DEFAULT_IMAGE;
  const parts = ["docker", "run", "-d", "--rm", "--name", name, "-p", `${port}:4566`];
  if (args.dockerSocket) parts.push("-v", "/var/run/docker.sock:/var/run/docker.sock");
  parts.push(image);
  return parts.join(" ");
}

/** Build the `docker rm -f` command. */
export function flociRmCommand(name: string): string {
  return `docker rm -f ${name}`;
}

/** The Floci health endpoint URL for a host port. */
export function flociHealthUrl(port: number): string {
  return `http://localhost:${port}/_localstack/health`;
}

/** The AWS env vars that point the `aws` CLI / SDK at a local Floci endpoint. */
export function flociEnv(port: number, region: string): Record<string, string> {
  return {
    AWS_ENDPOINT_URL: `http://localhost:${port}`,
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    AWS_REGION: region,
  };
}

/** True once the health body reports the required service (e.g. `"cloudformation"`). */
export function isFlociReady(healthBody: string, service: string): boolean {
  return healthBody.includes(`"${service}"`);
}

/**
 * Boot a local Floci AWS emulator in Docker and point subsequent steps at it.
 *
 * Idempotent: reuses a running container of the same name. Waits for the health
 * endpoint to report `readyService`, then sets `AWS_ENDPOINT_URL` + test creds in
 * the process environment so a following `nativeApply`/`cfn-deploy` targets the
 * emulator. Env injection assumes the in-process **local executor**; under a
 * distributed Temporal worker, pass the endpoint explicitly instead.
 *
 * Uses longInfra profile — 20m timeout, heartbeat every poll (the image may pull).
 */
export async function flociUp(args: FlociUpArgs, signal?: AbortSignal): Promise<{ endpoint: string }> {
  const name = args.name ?? DEFAULT_NAME;
  const port = args.port ?? DEFAULT_PORT;
  const region = args.region ?? DEFAULT_REGION;
  const service = args.readyService ?? DEFAULT_READY_SERVICE;
  const timeoutMs = args.timeoutMs ?? 60_000;
  const intervalMs = args.intervalMs ?? 2_000;

  let running = false;
  try {
    const { stdout } = await execAsync(flociExistsCommand(name), { signal });
    running = Boolean(stdout.trim());
  } catch {
    // `docker ps` failed — assume not running and try to start it.
  }

  if (running) {
    console.log(`Floci container "${name}" already running — reusing`);
  } else {
    await execAsync(flociRunCommand({ ...args, name, port }), { signal });
  }

  const url = flociHealthUrl(port);
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("flociUp aborted");
    safeHeartbeat({ step: "flociUp", container: name });
    try {
      const { stdout } = await execAsync(`curl -fs ${url}`, { signal });
      if (isFlociReady(stdout, service)) {
        ready = true;
        break;
      }
    } catch {
      // Not up yet (connection refused / non-2xx) — retry.
    }
    await sleep(intervalMs, signal);
  }
  if (!ready) {
    throw new Error(`Floci "${name}" did not become ready within ${timeoutMs}ms`);
  }

  const env = flociEnv(port, region);
  Object.assign(process.env, env);
  console.log(`Floci ready on ${env.AWS_ENDPOINT_URL} (service: ${service})`);
  return { endpoint: env.AWS_ENDPOINT_URL };
}

/**
 * Stop and remove the local Floci emulator container. A no-op success when the
 * container is already gone. Uses fastIdempotent profile — 5m timeout.
 */
export async function flociDown(args: FlociDownArgs, signal?: AbortSignal): Promise<void> {
  const name = args.name ?? DEFAULT_NAME;
  try {
    await execAsync(flociRmCommand(name), { signal });
  } catch {
    // Already removed (`--rm` on exit, or never started) — treat as success.
  }
}
