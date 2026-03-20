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

```typescript
// Single-stage:
export const builder = new Dockerfile({
  from: "node:20-alpine",
  workdir: "/app",
  copy: ["package*.json ./"],
  run: ["npm ci --only=production"],
  user: "node",
  cmd: `["node", "dist/index.js"]`,
});

// Multi-stage build:
export const app = new Dockerfile({
  stages: [
    {
      from: "node:20-alpine",
      as: "build",
      workdir: "/app",
      copy: ["package*.json ./"],
      run: ["npm ci", "npm run build"],
    },
    {
      from: "node:20-alpine",
      workdir: "/app",
      copy: ["--from=build /app/dist ./dist", "--from=build /app/node_modules ./node_modules"],
      user: "node",
      cmd: `["node", "dist/index.js"]`,
    },
  ],
});
```

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
export const builder = new Dockerfile({ from: "node:20-alpine", ... });
```

## Output structure

- All Compose entities → `docker-compose.yml`
- Each Dockerfile entity → `Dockerfile.{name}`

## Key rules

- `DKRS001`: Never use `:latest` image tags in source — use explicit versions
- `DKRD001`: Post-synth: no `:latest` images in generated YAML
- `DKRD002`: Post-synth: no unused named volumes
- `DKRD003`: Post-synth: SSH port 22 not exposed externally
- `DKRD010–012`: Dockerfile best practices (apt recommends, COPY vs ADD, USER)
