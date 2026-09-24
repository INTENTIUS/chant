import { DockerWebService } from "@intentius/chant-lexicon-docker";

/**
 * The app, declared through the docker lexicon's DockerWebService composite,
 * so the build IR names it as a composite instance (`app`, of kind
 * DockerWebService) and `chant workspace graph --composites` lists it with
 * the component that deploys it (app.component.ts). Compose runs it as the
 * service `appService`.
 *
 * The image is built from the app member's own Dockerfile. The compose file is
 * written to dist/, so the build context is two levels up from it. Until
 * member links land (#2539), nothing but this path says delivery depends on
 * the app.
 */
export const app = DockerWebService({
  build: { context: "../../app" },
  image: "reference-workspace-app:local",
  port: 8080,
  healthPath: "/healthz",
});
