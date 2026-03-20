/**
 * Well-known Docker and Docker Compose environment variable names.
 *
 * Use with the env() intrinsic for type-safe interpolation.
 *
 * @example
 * import { env, DOCKER_VARS } from "@intentius/chant-lexicon-docker";
 *
 * export const api = new Service({
 *   environment: {
 *     BUILDKIT_ENABLED: env(DOCKER_VARS.DOCKER_BUILDKIT),
 *   },
 * });
 */

/** Docker daemon and client environment variables */
export const DOCKER_VARS = {
  /** Enable Docker BuildKit: DOCKER_BUILDKIT=1 */
  DOCKER_BUILDKIT: "DOCKER_BUILDKIT",
  /** Docker host socket/address */
  DOCKER_HOST: "DOCKER_HOST",
  /** Docker TLS verify */
  DOCKER_TLS_VERIFY: "DOCKER_TLS_VERIFY",
  /** Docker config directory */
  DOCKER_CONFIG: "DOCKER_CONFIG",
  /** Docker content trust */
  DOCKER_CONTENT_TRUST: "DOCKER_CONTENT_TRUST",
} as const;

/** Docker Compose specific environment variables */
export const COMPOSE_VARS = {
  /** Override project name: COMPOSE_PROJECT_NAME */
  COMPOSE_PROJECT_NAME: "COMPOSE_PROJECT_NAME",
  /** Override compose file: COMPOSE_FILE */
  COMPOSE_FILE: "COMPOSE_FILE",
  /** Path separator for COMPOSE_FILE */
  COMPOSE_PATH_SEPARATOR: "COMPOSE_PATH_SEPARATOR",
  /** Docker compose profiles to enable */
  COMPOSE_PROFILES: "COMPOSE_PROFILES",
  /** Compose conversion flag */
  COMPOSE_CONVERT_WINDOWS_PATHS: "COMPOSE_CONVERT_WINDOWS_PATHS",
  /** Docker host for compose */
  DOCKER_DEFAULT_PLATFORM: "DOCKER_DEFAULT_PLATFORM",
} as const;

export type DockerVar = (typeof DOCKER_VARS)[keyof typeof DOCKER_VARS];
export type ComposeVar = (typeof COMPOSE_VARS)[keyof typeof COMPOSE_VARS];
