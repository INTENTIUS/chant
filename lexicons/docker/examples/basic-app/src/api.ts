import { Dockerfile } from "@intentius/chant-lexicon-docker";

/**
 * Multi-stage Dockerfile for the API service.
 *
 * Stage 1 (builder): Install deps and compile TypeScript.
 * Stage 2 (runtime): Minimal production image.
 */
export const api = new Dockerfile({
  stages: [
    {
      from: "node:20-alpine",
      as: "builder",
      workdir: "/app",
      copy: ["package*.json ./"],
      run: ["npm ci --only=production"],
    },
    {
      from: "node:20-alpine",
      workdir: "/app",
      copy: ["--from=builder /app/node_modules ./node_modules", "--from=builder /app/dist ./dist"],
      user: "node",
      expose: ["8080"],
      cmd: `["node", "dist/index.js"]`,
    },
  ],
});
