import { emulatorLifecycle, type EmulatorCapability, type EmulatorSpec } from "@intentius/chant/op";

export interface FlociAzUpArgs {
  /** Container name. Default: `chant-floci-az`. */
  name?: string;
  /** Host port mapped to the emulator's `:4577`. Default: `4577`. */
  port?: number;
  /** Image. Default: the pinned `floci/floci-az` tag. */
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
// Pinned rather than `:latest` (#1345): an image that moves underneath a
// passing local suite is exactly the drift a pin exists to stop.
export const FLOCI_AZ_SPEC: EmulatorSpec = {
  name: "chant-floci-az",
  image: "floci/floci-az:0.10.0",
  containerPort: 4577,
  healthPath: "/_floci/health",
  upstream: { repo: "floci-io/floci-az" },
};

/**
 * The azure plugin's emulator capability (#1345).
 *
 * The spec below has existed since #746; what was missing was declaring it, so
 * `chant emulator up --all` booted Floci and nothing else even though floci-az
 * was one line away. `AZURE_ENDPOINT_URL` is the var azure's own
 * `describe-resources.ts` and `deep-observe.ts` already read on every live
 * call, which is also what makes `--live --env <local>` reach the emulator
 * instead of real Azure.
 */
export const FLOCI_AZ_EMULATOR: EmulatorCapability = {
  spec: FLOCI_AZ_SPEC,
  env: (endpoint) => ({ AZURE_ENDPOINT_URL: endpoint }),
};

const az = emulatorLifecycle(FLOCI_AZ_SPEC);

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
