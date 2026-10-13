import { Dockerfile } from "@intentius/chant-lexicon-docker";

/**
 * Multi-stage Dockerfile for the API service.
 *
 * Stage 1 (builder): install dependencies, compile TypeScript, then drop the
 * dev dependencies. The manifests are copied before the source so the
 * install layer is reused until package*.json changes.
 * Stage 2 (runtime): minimal production image, running as the node user.
 */
export const apiImage = new Dockerfile({
  stages: [
    {
      from: "node:20-alpine",
      as: "builder",
      steps: [
        { workdir: "/app" },
        { copy: "package*.json ./" },
        { run: "npm ci" },
        { copy: ". ." },
        { run: "npm run build" },
        { run: "npm prune --omit=dev" },
      ],
    },
    {
      from: "node:20-alpine",
      steps: [
        { workdir: "/app" },
        { copy: "--from=builder /app/node_modules ./node_modules" },
        { copy: "--from=builder /app/dist ./dist" },
        { user: "node" },
        { expose: 8080 },
        { cmd: ["node", "dist/index.js"] },
      ],
    },
  ],
});
