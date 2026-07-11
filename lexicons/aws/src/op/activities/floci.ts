import { emulatorLifecycle } from "@intentius/chant/op";

const DEFAULT_NAME = "chant-floci";
const DEFAULT_PORT = 4566;
const DEFAULT_IMAGE = "floci/floci:latest";
const DEFAULT_REGION = "us-east-1";
const DEFAULT_READY_SERVICE = "cloudformation";
const DOCKER_SOCK = ["-v", "/var/run/docker.sock:/var/run/docker.sock"] as const;

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

/** True once the health body reports the required service (e.g. `"cloudformation"`). */
export function isFlociReady(healthBody: string, service: string): boolean {
  return healthBody.includes(`"${service}"`);
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

// AWS runs the LocalStack-compatible floci/floci image, so readiness is gated on
// a service (`cloudformation`) appearing in `/_localstack/health` — unlike the
// bespoke az/gcp fakes. Shared lifecycle: emulatorLifecycle (#746).
const flociFor = (readyService: string) =>
  emulatorLifecycle({
    name: DEFAULT_NAME,
    image: DEFAULT_IMAGE,
    containerPort: DEFAULT_PORT,
    healthPath: "/_localstack/health",
    ready: (body) => isFlociReady(body, readyService),
  });

const builders = flociFor(DEFAULT_READY_SERVICE);

export const flociExistsCommand = builders.existsCommand;
export const flociRmCommand = builders.rmCommand;
export const flociHealthUrl = builders.healthUrl;

/** Build the `docker run` command that boots Floci. */
export function flociRunCommand(args: FlociUpArgs = {}): string {
  return builders.runCommand({
    name: args.name,
    port: args.port,
    image: args.image,
    extraArgs: args.dockerSocket ? [...DOCKER_SOCK] : [],
  });
}

/**
 * Boot a local Floci AWS emulator in Docker and point subsequent steps at it.
 *
 * Idempotent: reuses a running container of the same name. Waits for the health
 * endpoint to report `readyService`, then sets `AWS_ENDPOINT_URL` + test creds in
 * the process environment so a following `nativeApply`/`cfn-deploy` targets the
 * emulator. Env injection assumes the in-process local executor; under a
 * distributed Temporal worker, pass the endpoint explicitly instead.
 */
export async function flociUp(args: FlociUpArgs = {}, signal?: AbortSignal): Promise<{ endpoint: string }> {
  const region = args.region ?? DEFAULT_REGION;
  const service = args.readyService ?? DEFAULT_READY_SERVICE;
  const { endpoint } = await flociFor(service).up(
    {
      name: args.name,
      port: args.port,
      image: args.image,
      timeoutMs: args.timeoutMs,
      intervalMs: args.intervalMs,
      extraArgs: args.dockerSocket ? [...DOCKER_SOCK] : [],
    },
    signal,
  );
  Object.assign(process.env, flociEnv(args.port ?? DEFAULT_PORT, region));
  return { endpoint };
}

/** Stop and remove the local Floci emulator container (no-op if already gone). */
export async function flociDown(args: FlociDownArgs = {}, signal?: AbortSignal): Promise<void> {
  return builders.down(args, signal);
}
