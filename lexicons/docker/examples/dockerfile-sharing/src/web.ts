import { Dockerfile, type DockerfileStage } from "@intentius/chant-lexicon-docker";
import { NODE_IMAGE, nodeBuild, nodeRuntime } from "./shared/node";

const runtime: DockerfileStage = {
  from: NODE_IMAGE,
  steps: [
    ...nodeRuntime,
    { expose: 3000 },
    { cmd: ["node", "dist/server.js"] },
  ],
};

const web = new Dockerfile({ stages: [nodeBuild, runtime] });

export { web };
