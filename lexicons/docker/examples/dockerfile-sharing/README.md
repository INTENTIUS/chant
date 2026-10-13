# Docker dockerfile-sharing example

Two Dockerfiles, `web` and `worker`, built from one shared module. `src/shared/node.ts` exports a build stage (as a function of the service directory) and the steps every runtime stage starts with. Each Dockerfile imports them and spreads or extends them.

## What this produces

Running `npm run build` generates `dist/Dockerfile.web` and `dist/Dockerfile.worker`.

## Files

- `src/shared/node.ts`: the shared stage and steps
- `src/web.ts`: the web service's Dockerfile
- `src/worker.ts`: the worker's Dockerfile, which passes a test step into the shared build stage
