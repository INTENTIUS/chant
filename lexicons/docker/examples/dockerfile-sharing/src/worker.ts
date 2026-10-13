import { Dockerfile, type DockerfileStage } from "@intentius/chant-lexicon-docker";
import { NODE_IMAGE, nodeBuild, nodeRuntime, npmInstall } from "./shared/node";

/** The shared build stage with the tests added, before the dev dependencies are pruned. */
const build: DockerfileStage = {
  ...nodeBuild,
  steps: [
    { workdir: "/app" },
    ...npmInstall,
    { copy: ". ." },
    { run: "npm run build" },
    { run: "npm test" },
    { run: "npm prune --omit=dev" },
  ],
};

const runtime: DockerfileStage = {
  from: NODE_IMAGE,
  steps: [
    ...nodeRuntime,
    { stopsignal: "SIGINT" },
    { cmd: ["node", "dist/worker.js"] },
  ],
};

const worker = new Dockerfile({ stages: [build, runtime] });

export { worker };
