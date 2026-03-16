import { NodePipeline } from "@intentius/chant-lexicon-gitlab";

export const app = NodePipeline({
  nodeVersion: "22",
  installCommand: "npm install",
  buildScript: "build",
  testScript: "test",
});
