import { emulatorLifecycle, type EmulatorCapability, type EmulatorSpec } from "@intentius/chant/op";
import { SPRITZER_IMAGE, SPRITZER_CONTAINER_IMAGE } from "./emulator-images";

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

// ── Container exec mode (#2711, INTENTIUS/spritzer#22) ─────────────────────────
//
// A second, distinct spritzer lifecycle: `SPRITZER_EXEC=container` with the
// Docker runtime, so each sprite it makes is a real container — the mode the
// Services CRUD activities (`./sprite-services.ts`) and `spriteUrl` need (real
// processes, a real sprite URL), and that `SPRITZER_SPEC` above (interpreter
// mode, the default everything else tests against) does not run. The Docker
// socket is mounted read-write so spritzer can create/exec/delete sibling
// sprite containers through it (docker-outside-of-docker); no port publishing
// is needed for the sprites themselves — spritzer reaches them by exec, and
// proxies their URL (`/s/{name}/...`) through the one published port.

/** Container exec mode spritzer, pinned to {@link SPRITZER_CONTAINER_IMAGE} (0.6.0, the first release with this mode). */
export const SPRITZER_CONTAINER_SPEC: EmulatorSpec = {
  name: "chant-spritzer-container",
  image: SPRITZER_CONTAINER_IMAGE,
  containerPort: 4290,
  healthPath: "/_spritzer/health",
  runArgs: [
    // The image runs as `nonroot` by default, which cannot open a
    // group/other-unwritable host socket — root inside the container is
    // still an unprivileged Linux user account relative to the host/Docker
    // Desktop VM, no different from any other `docker run` that mounts the
    // socket.
    "--user",
    "root",
    "-e",
    "SPRITZER_EXEC=container",
    "-e",
    "SPRITZER_RUNTIME=docker",
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
  ],
  upstream: { repo: "intentius/spritzer" },
};

const spritzerContainer = emulatorLifecycle(SPRITZER_CONTAINER_SPEC);

export const spritesContainerRunCommand = (args: SpritesUpArgs = {}): string => spritzerContainer.runCommand(args);
export const spritesContainerExistsCommand = spritzerContainer.existsCommand;
export const spritesContainerRmCommand = spritzerContainer.rmCommand;
export const spritesContainerHealthUrl = spritzerContainer.healthUrl;

/** Boot a local spritzer in container exec mode (Docker runtime) and return its endpoint. */
export const spritesContainerUp = (args: SpritesUpArgs = {}, signal?: AbortSignal): Promise<{ endpoint: string }> =>
  spritzerContainer.up(args, signal);

/** Stop and remove the local container-exec-mode spritzer (no-op if already gone). Sprite containers it made are the caller's to clean up (see the integration test). */
export const spritesContainerDown = (args: SpritesDownArgs = {}, signal?: AbortSignal): Promise<void> =>
  spritzerContainer.down(args, signal);
