/**
 * DockerWebService composite: one HTTP service as a Compose service, built
 * from a Dockerfile or run from an image, listening on one port, with a
 * health check on an HTTP path.
 *
 * It is the shape a single web app takes when Compose runs it, and the kind a
 * component names in its contract's `composites` when it deploys one
 * (#2662), so `chant workspace graph --composites` can offer that component
 * for the instance.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Service } from "../generated/index";

export interface DockerWebServiceProps {
  /** Build the image from a Dockerfile: the context, and the Dockerfile's path in it (default: "Dockerfile"). */
  build?: { context: string; dockerfile?: string };
  /** The image to run, or the tag to give the built one. One of `build` and `image` is required. */
  image?: string;
  /** The port the app listens on in the container. It is also passed to the app as `PORT`. */
  port: number;
  /** The port published on the host (default: `port`). */
  hostPort?: number;
  /** More environment variables. A `PORT` here overrides the one from `port`. */
  environment?: Record<string, string>;
  /** An HTTP path the health check fetches with `wget` inside the container (default: no health check). */
  healthPath?: string;
  /** Restart policy (default: "unless-stopped"). */
  restart?: string;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    service?: Partial<Record<string, unknown>>;
  };
}

/**
 * One HTTP service as a Compose service, with a published port and an HTTP
 * health check. Returns the service, keyed by the export name plus `Service`.
 *
 * @example
 * ```ts
 * import { DockerWebService } from "@intentius/chant-lexicon-docker";
 *
 * export const app = DockerWebService({
 *   build: { context: "../app" },
 *   image: "app:local",
 *   port: 8080,
 *   healthPath: "/healthz",
 * });
 * ```
 */
export const DockerWebService = Composite((props: DockerWebServiceProps) => {
  const { build, image, port, hostPort = port, environment, healthPath, restart = "unless-stopped", defaults: defs } = props;
  if (!build && !image) throw new Error("DockerWebService: give `build`, `image`, or both");

  const service = new Service(mergeDefaults({
    ...(build ? { build: { context: build.context, dockerfile: build.dockerfile ?? "Dockerfile" } } : {}),
    ...(image ? { image } : {}),
    ports: [`${hostPort}:${port}`],
    environment: { PORT: String(port), ...environment },
    restart,
    ...(healthPath
      ? {
          healthcheck: {
            test: ["CMD", "wget", "-qO-", `http://127.0.0.1:${port}${healthPath}`],
            interval: "30s",
            timeout: "5s",
            retries: 3,
          },
        }
      : {}),
  }, defs?.service));

  return { service };
}, "DockerWebService");
