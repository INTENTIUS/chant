import { emulatorLifecycle } from "@intentius/chant/op";

export interface SpritesUpArgs {
  /** Container name. Default: `chant-spritzer`. */
  name?: string;
  /** Host port mapped to the emulator's `:4290`. Default: `4290`. */
  port?: number;
  /** Image. Default: `ghcr.io/intentius/spritzer:0.2.0`. */
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
const spritzer = emulatorLifecycle({
  name: "chant-spritzer",
  image: "ghcr.io/intentius/spritzer:0.2.0",
  containerPort: 4290,
  healthPath: "/_spritzer/health",
});

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
