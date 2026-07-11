import { emulatorLifecycle } from "@intentius/chant/op";

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

// floci-az is a bespoke ARM fake (not LocalStack) — a plain 200 on its health
// endpoint means ready. Shared lifecycle: emulatorLifecycle (#746).
const az = emulatorLifecycle({
  name: "chant-floci-az",
  image: "floci/floci-az:latest",
  containerPort: 4577,
  healthPath: "/_floci/health",
});

export const flociAzExistsCommand = az.existsCommand;
export const flociAzRmCommand = az.rmCommand;
export const flociAzHealthUrl = az.healthUrl;
/** The ARM endpoint URL (what `azApply`'s `endpoint` should point at). */
export const flociAzEndpoint = az.endpoint;
export const flociAzRunCommand = (args: FlociAzUpArgs = {}): string => az.runCommand(args);

/** Boot a local floci-az (Azure emulator) in Docker and return its ARM endpoint. */
export const flociAzUp = (args: FlociAzUpArgs = {}, signal?: AbortSignal): Promise<{ endpoint: string }> =>
  az.up(args, signal);

/** Stop and remove the local floci-az container (no-op if already gone). */
export const flociAzDown = (args: FlociAzDownArgs = {}, signal?: AbortSignal): Promise<void> =>
  az.down(args, signal);
