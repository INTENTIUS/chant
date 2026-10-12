# chant-docker

You are helping a developer define Docker Compose services and Dockerfiles using the `@intentius/chant-lexicon-docker` library.

## Core types

```typescript
import { Service, Volume, Network, Dockerfile, env, defaultLabels } from "@intentius/chant-lexicon-docker";
```

## Service — docker-compose.yml services:

```typescript
export const api = new Service({
  image: "myapp:1.0",
  ports: ["8080:8080"],
  environment: {
    NODE_ENV: "production",
    DB_URL: env("DATABASE_URL", { required: true }),
  },
  depends_on: ["db"],
  restart: "unless-stopped",
  healthcheck: {
    test: ["CMD", "curl", "-f", "http://localhost:8080/health"],
    interval: "30s",
    timeout: "10s",
    retries: 3,
  },
});
```

## Volume — top-level named volume:

```typescript
export const pgdata = new Volume({});
// With driver options:
export const nfsdata = new Volume({ driver: "local", driver_opts: { type: "nfs", o: "addr=..." } });
```

## Dockerfile — generates Dockerfile.{name}:

Each stage is `from` plus `steps`. A step is an object with one key naming one instruction. Steps are written exactly in the order listed.

```typescript
// Single stage. Manifests before source, so the install layer is cached; root setup before USER.
export const server = new Dockerfile({
  from: "node:20-alpine",
  steps: [
    { workdir: "/app" },
    { copy: "package.json package-lock.json ./" },
    { run: "npm ci --omit=dev" },
    { copy: "src/ ./src/" },
    { user: "node" },
    { expose: 3000 },
    { cmd: ["node", "src/index.js"] },  // a list is written in JSON exec form
  ],
});

// Multi-stage build:
export const app = new Dockerfile({
  stages: [
    {
      from: "node:20-alpine",
      as: "build",
      steps: [
        { workdir: "/app" },
        { copy: "package.json package-lock.json ./" },
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
        { copy: "--from=build /app/node_modules ./node_modules" },
        { copy: "--from=build /app/dist ./dist" },
        { user: "node" },
        { cmd: ["node", "dist/index.js"] },
      ],
    },
  ],
});
```

Step keys: `arg`, `env`, `workdir`, `user`, `run`, `copy`, `add`, `expose`, `volume`, `label`, `entrypoint`, `cmd`, `healthcheck`, `shell`, `stopsignal`, `onbuild`. `from` and `as` are stage fields, and `globalArgs: ["NAME=value"]` writes `ARG` lines before the first `FROM`. `run`, `cmd`, `entrypoint` and `shell` take a string or a list (exec form); `expose` takes a number too.

Rules:
- Use `steps`. The older per-kind fields (`run: [...]`, `copy: [...]`, `user`) are written in a fixed order (ARG, ENV, WORKDIR, USER, RUN, COPY, ADD, EXPOSE, VOLUME, LABEL, ENTRYPOINT, CMD, HEALTHCHECK), not the order written, so every RUN lands before every COPY. Lint rule DKRS002 flags this, and `chant lint --fix` rewrites them as steps.
- A stage can't have both `steps` and per-kind fields, and a step can't name two instructions. Both are build errors.
- To share stages or steps between Dockerfiles in different modules, export a `const` stage (`DockerfileStage`) or step list (`DockerfileStep[]`) and import it. List the stage in `stages`, or spread the steps: `steps: [...nodeRuntime, { cmd: ["node", "dist/server.js"] }]`. This is chant's equivalent of an INCLUDE. Spreading a function call's result is a lint error (EVL004); put parameterized Dockerfiles in a `Composite`.

## Variable interpolation with env():

```typescript
import { env } from "@intentius/chant-lexicon-docker";

// ${VAR} — required, no default:
env("DATABASE_URL")

// ${VAR:-default} — use default if unset:
env("LOG_LEVEL", { default: "info" })

// ${VAR:?message} — fail with error if unset:
env("API_SECRET", { required: true })
env("API_SECRET", { errorMessage: "API_SECRET must be set in .env" })

// ${VAR:+value} — substitute value if VAR is set:
env("DEBUG", { ifSet: "verbose" })
```

## Default labels (injected into all services):

```typescript
export const labels = defaultLabels({
  "com.example.team": "platform",
  "com.example.managed-by": "chant",
  "com.example.version": "1.0.0",
});
```

## Service → Dockerfile cross-reference:

```typescript
// The serializer emits "Dockerfile.builder" as the filename.
// Reference it in the service build config:
export const api = new Service({
  build: {
    context: ".",
    dockerfile: "Dockerfile.builder",  // matches the Dockerfile entity name
  },
  ports: ["8080:8080"],
});
export const builder = new Dockerfile({
  from: "node:20-alpine",
  steps: [{ workdir: "/app" }, { copy: ". ." }, { run: "npm ci" }, { user: "node" }, { cmd: ["node", "index.js"] }],
});
```

## Output structure

- All Compose entities → `docker-compose.yml`
- Each Dockerfile entity → `Dockerfile.{name}`

## Key rules

- `DKRS001`: Never use `:latest` image tags in source — use explicit versions
- `DKRD001`: Post-synth: no `:latest` images in generated YAML
- `DKRD002`: Post-synth: no unused named volumes
- `DKRD003`: Post-synth: SSH port 22 not exposed externally
- `DKRS002`: Dockerfile per-kind fields declared in an order the fixed order changes; use `steps`
- `DKRD010–012`: Dockerfile best practices (apt recommends, COPY vs ADD, final stage USER)
- `DKRD013–020`: order-aware Dockerfile checks: COPY . before a dependency install, root-only RUN after USER, repeated CMD/ENTRYPOINT, COPY --from an undefined stage, unused ARG before FROM, relative WORKDIR, ADD of a URL without --checksum, apt-get update in its own RUN
