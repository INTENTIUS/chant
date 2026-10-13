# The demo agent: one TypeScript file, run by Node's own type stripping.
FROM node:22-bookworm-slim
WORKDIR /app
COPY --chmod=0444 agent.ts .
USER node
CMD ["node", "--experimental-strip-types", "--no-warnings", "agent.ts"]
