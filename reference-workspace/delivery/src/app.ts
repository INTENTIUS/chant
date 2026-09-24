import { Service } from "@intentius/chant-lexicon-docker";

/**
 * The image is built from the app member's own Dockerfile. The compose file is
 * written to dist/, so the build context is two levels up from it. Until
 * member links land (#2539), nothing but this path says delivery depends on
 * the app.
 */
export const appBuild = { context: "../../app", dockerfile: "Dockerfile" };

export const appEnvironment = { PORT: "8080" };

export const appHealthcheck = {
  test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/healthz"],
  interval: "30s",
  timeout: "5s",
  retries: 3,
};

export const app = new Service({
  build: appBuild,
  image: "reference-workspace-app:local",
  ports: ["8080:8080"],
  environment: appEnvironment,
  restart: "unless-stopped",
  healthcheck: appHealthcheck,
});
