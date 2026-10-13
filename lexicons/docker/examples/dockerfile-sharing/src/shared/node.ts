import type { DockerfileStage, DockerfileStep } from "@intentius/chant-lexicon-docker";

export const NODE_IMAGE = "node:20-alpine";

/** Copy the manifests and install, so the install layer is reused until they change. */
export const npmInstall: DockerfileStep[] = [
  { copy: "package.json package-lock.json ./" },
  { run: "npm ci" },
];

/** The build stage every Node service uses. Later stages copy from it as "build". */
export const nodeBuild: DockerfileStage = {
  from: NODE_IMAGE,
  as: "build",
  steps: [
    { workdir: "/app" },
    ...npmInstall,
    { copy: ". ." },
    { run: "npm run build" },
    { run: "npm prune --omit=dev" },
  ],
};

/** The start of every runtime stage: the built app, run as the node user. */
export const nodeRuntime: DockerfileStep[] = [
  { workdir: "/app" },
  { copy: "--from=build /app/node_modules ./node_modules" },
  { copy: "--from=build /app/dist ./dist" },
  { user: "node" },
];
