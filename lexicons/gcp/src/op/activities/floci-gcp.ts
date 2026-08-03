import { emulatorLifecycle, type EmulatorCapability, type EmulatorSpec } from "@intentius/chant/op";

export interface FlociGcpUpArgs {
  /** Container name. Default: `chant-floci-gcp`. */
  name?: string;
  /** Host port mapped to the emulator's `:4588`. Default: `4588`. */
  port?: number;
  /** Image. Default: the pinned `floci/floci-gcp` tag. */
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

// floci-gcp is a bespoke GCP-REST fake (not LocalStack) — a plain 200 on its
// health endpoint means ready. Shared lifecycle: emulatorLifecycle (#746).
// Pinned rather than `:latest` (#1345), same reasoning as the other emulators.
export const FLOCI_GCP_SPEC: EmulatorSpec = {
  name: "chant-floci-gcp",
  image: "floci/floci-gcp:0.5.0",
  containerPort: 4588,
  healthPath: "/_floci-gcp/health",
  upstream: { repo: "floci-io/floci-gcp" },
};

/**
 * The gcp plugin's emulator capability (#1345).
 *
 * `env` is deliberately empty: `gcpApply` reaches the emulator through an
 * explicit `endpoint` argument rather than an ambient variable, so there is no
 * var to inject and claiming one would be worse than claiming none. The
 * endpoint is still reported by `chant emulator up --json`.
 */
export const FLOCI_GCP_EMULATOR: EmulatorCapability = {
  spec: FLOCI_GCP_SPEC,
  env: () => ({}),
};

const gcp = emulatorLifecycle(FLOCI_GCP_SPEC);

export const flociGcpExistsCommand = gcp.existsCommand;
export const flociGcpRmCommand = gcp.rmCommand;
export const flociGcpHealthUrl = gcp.healthUrl;
/** The GCP endpoint URL (what `gcpApply`'s `endpoint` should point at). */
export const flociGcpEndpoint = gcp.endpoint;
export const flociGcpRunCommand = (args: FlociGcpUpArgs = {}): string => gcp.runCommand(args);

/** Boot a local floci-gcp (GCP emulator) in Docker and return its endpoint. */
export const flociGcpUp = (args: FlociGcpUpArgs = {}, signal?: AbortSignal): Promise<{ endpoint: string }> =>
  gcp.up(args, signal);

/** Stop and remove the local floci-gcp container (no-op if already gone). */
export const flociGcpDown = (args: FlociGcpDownArgs = {}, signal?: AbortSignal): Promise<void> =>
  gcp.down(args, signal);
