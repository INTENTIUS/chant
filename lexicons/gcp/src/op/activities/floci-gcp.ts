import { emulatorLifecycle } from "@intentius/chant/op";

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

// floci-gcp is a bespoke GCP-REST fake (not LocalStack) — a plain 200 on its
// health endpoint means ready. Shared lifecycle: emulatorLifecycle (#746).
const gcp = emulatorLifecycle({
  name: "chant-floci-gcp",
  image: "floci/floci-gcp:latest",
  containerPort: 4588,
  healthPath: "/_floci-gcp/health",
});

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
