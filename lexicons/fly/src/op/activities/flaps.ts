import { emulatorLifecycle, type EmulatorCapability, type EmulatorSpec } from "@intentius/chant/op";
import { MUDFLAPS_IMAGE } from "./emulator-images";

export interface FlapsUpArgs {
  /** Container name. Default: `chant-mudflaps`. */
  name?: string;
  /** Host port mapped to the emulator's `:4280`. Default: `4280`. */
  port?: number;
  /** Image. Default: the pinned mudflaps image ({@link MUDFLAPS_IMAGE}). */
  image?: string;
  /** Readiness timeout in ms. Default: `60000`. */
  timeoutMs?: number;
  /** Health poll interval in ms. Default: `2000`. */
  intervalMs?: number;
}

export interface FlapsDownArgs {
  /** Container name to remove. Default: `chant-mudflaps`. */
  name?: string;
}

// mudflaps is a stateful fake of the Fly Machines API (flaps) — a plain 200 on
// its health endpoint means ready. The local target for flyApply; point it there
// with FLY_FLAPS_BASE_URL. Shared lifecycle: emulatorLifecycle (#746).
export const MUDFLAPS_SPEC: EmulatorSpec = {
  name: "chant-mudflaps",
  image: MUDFLAPS_IMAGE,
  containerPort: 4280,
  healthPath: "/_mudflaps/health",
  upstream: { repo: "intentius/mudflaps" },
};

/**
 * The Machines half of fly's emulator capability (#1345).
 *
 * fly ships two emulators, and `LexiconPlugin.emulator` held exactly one until
 * #1345 widened it — so neither was declared and `chant emulator` reported fly
 * as having none, while the tutorials booted mudflaps through `chant run`.
 */
export const MUDFLAPS_EMULATOR: EmulatorCapability = {
  spec: MUDFLAPS_SPEC,
  env: (endpoint) => ({ FLY_FLAPS_BASE_URL: endpoint }),
};

const flaps = emulatorLifecycle(MUDFLAPS_SPEC);

export const flapsExistsCommand = flaps.existsCommand;
export const flapsRmCommand = flaps.rmCommand;
export const flapsHealthUrl = flaps.healthUrl;
/** The flaps endpoint URL (what `flyApply`'s `FLY_FLAPS_BASE_URL`/`endpoint` points at). */
export const flapsEndpoint = flaps.endpoint;
export const flapsRunCommand = (args: FlapsUpArgs = {}): string => flaps.runCommand(args);

/** Boot a local mudflaps (Fly Machines API emulator) in Docker and return its endpoint. */
export const flapsUp = (args: FlapsUpArgs = {}, signal?: AbortSignal): Promise<{ endpoint: string }> =>
  flaps.up(args, signal);

/** Stop and remove the local mudflaps container (no-op if already gone). */
export const flapsDown = (args: FlapsDownArgs = {}, signal?: AbortSignal): Promise<void> =>
  flaps.down(args, signal);
