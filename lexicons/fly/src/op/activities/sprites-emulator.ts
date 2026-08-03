import { emulatorLifecycle, type EmulatorCapability, type EmulatorSpec } from "@intentius/chant/op";
import { SPRITZER_IMAGE } from "./emulator-images";

export interface SpritesUpArgs {
  /** Container name. Default: `chant-spritzer`. */
  name?: string;
  /** Host port mapped to the emulator's `:4290`. Default: `4290`. */
  port?: number;
  /** Image. Default: the pinned spritzer image ({@link SPRITZER_IMAGE}). */
  image?: string;
  /** Readiness timeout in ms. Default: `60000`. */
  timeoutMs?: number;
  /** Health poll interval in ms. Default: `2000`. */
  intervalMs?: number;
}

export interface SpritesDownArgs {
  /** Container name to remove. Default: `chant-spritzer`. */
  name?: string;
}

// spritzer is a stateful fake of the Fly Sprites API — a plain 200 on its health
// endpoint means ready. The local target for the sprite activities; point them
// there with SPRITES_BASE_URL. Shared lifecycle: emulatorLifecycle (the same
// helper that boots mudflaps for fly).
export const SPRITZER_SPEC: EmulatorSpec = {
  name: "chant-spritzer",
  image: SPRITZER_IMAGE,
  containerPort: 4290,
  healthPath: "/_spritzer/health",
  upstream: { repo: "intentius/spritzer" },
};

/** The Sprites half of fly's emulator capability (#1345). */
export const SPRITZER_EMULATOR: EmulatorCapability = {
  spec: SPRITZER_SPEC,
  env: (endpoint) => ({ SPRITES_BASE_URL: endpoint }),
};

const spritzer = emulatorLifecycle(SPRITZER_SPEC);

export const spritesExistsCommand = spritzer.existsCommand;
export const spritesRmCommand = spritzer.rmCommand;
export const spritesHealthUrl = spritzer.healthUrl;
/** The Sprites endpoint URL (what the sprite activities' `SPRITES_BASE_URL`/`endpoint` points at). */
export const spritesEndpoint = spritzer.endpoint;
export const spritesRunCommand = (args: SpritesUpArgs = {}): string => spritzer.runCommand(args);

/** Boot a local spritzer (Fly Sprites API emulator) in Docker and return its endpoint. */
export const spritesUp = (args: SpritesUpArgs = {}, signal?: AbortSignal): Promise<{ endpoint: string }> =>
  spritzer.up(args, signal);

/** Stop and remove the local spritzer container (no-op if already gone). */
export const spritesDown = (args: SpritesDownArgs = {}, signal?: AbortSignal): Promise<void> =>
  spritzer.down(args, signal);
