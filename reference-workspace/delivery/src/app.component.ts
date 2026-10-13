/**
 * The component that deploys the app (#2662). Its contract names the
 * composite kind it deploys, so `chant workspace graph --composites` joins it
 * to the `app` instance in app.ts by `composites`, not by name.
 *
 * It builds the image from the app member's Dockerfile, starts the Compose
 * file `npm run build` writes to dist/, and waits for the health endpoint.
 * The paths are from this member's directory, where chant runs it.
 */
import { phase, type Component } from "@intentius/chant/components/component";
import { dockerBuild, shell, waitEndpoint } from "@intentius/chant/components/builders";

export const appComponent: Component = {
  name: "app",
  archetype: "service",
  composites: ["DockerWebService"],
  dependsOn: [],
  build: dockerBuild({ context: "../app", into: "archive" }),
  deploy: [
    phase("Apply", [
      shell({
        cmd: "docker compose -f dist/docker-compose.yml up -d --build",
        reason: "the docker lexicon has no capability that starts a Compose file on this machine",
      }),
    ]),
    phase("Verify", [waitEndpoint({ url: "http://127.0.0.1:8080/healthz", intervalMs: 1000, timeoutMs: 60_000 })]),
  ],
};
