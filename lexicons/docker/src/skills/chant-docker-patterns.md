# chant-docker-patterns

Common Docker Compose and Dockerfile patterns using `@intentius/chant-lexicon-docker`.

## Database service with volume

```typescript
import { Service, Volume, env } from "@intentius/chant-lexicon-docker";

export const postgres = new Service({
  image: "postgres:16-alpine",
  environment: {
    POSTGRES_DB: "myapp",
    POSTGRES_USER: "myapp",
    POSTGRES_PASSWORD: env("POSTGRES_PASSWORD", { required: true }),
  },
  volumes: ["pgdata:/var/lib/postgresql/data"],
  restart: "unless-stopped",
  healthcheck: {
    test: ["CMD-SHELL", "pg_isready -U myapp"],
    interval: "10s",
    timeout: "5s",
    retries: 5,
  },
});

export const pgdata = new Volume({});
```

## Redis cache

```typescript
export const redis = new Service({
  image: "redis:7-alpine",
  volumes: ["redisdata:/data"],
  command: "redis-server --appendonly yes",
  restart: "unless-stopped",
});
export const redisdata = new Volume({});
```

## Reverse proxy (nginx)

```typescript
export const nginx = new Service({
  image: "nginx:1.25-alpine",
  ports: ["80:80", "443:443"],
  volumes: ["./nginx.conf:/etc/nginx/nginx.conf:ro", "./certs:/etc/ssl/certs:ro"],
  depends_on: ["api"],
  restart: "unless-stopped",
});
```

## Multi-stage Node.js Dockerfile

Manifests before source so the install layer is cached; the runtime stage takes only what it needs and runs as `node`.

```typescript
export const nodeApp = new Dockerfile({
  stages: [
    {
      from: "node:20-alpine",
      as: "deps",
      steps: [
        { workdir: "/app" },
        { copy: "package.json package-lock.json ./" },
        { run: "npm ci --omit=dev" },
      ],
    },
    {
      from: "node:20-alpine",
      as: "build",
      steps: [
        { workdir: "/app" },
        { copy: "package.json package-lock.json ./" },
        { run: "npm ci" },
        { copy: ". ." },
        { run: "npm run build" },
      ],
    },
    {
      from: "node:20-alpine",
      steps: [
        { workdir: "/app" },
        { copy: "--from=deps /app/node_modules ./node_modules" },
        { copy: "--from=build /app/dist ./dist" },
        { user: "node" },
        { expose: 3000 },
        { cmd: ["node", "dist/index.js"] },
      ],
    },
  ],
});
```

## Python service

```typescript
export const pythonApp = new Dockerfile({
  from: "python:3.12-slim",
  steps: [
    { workdir: "/app" },
    { env: "PYTHONUNBUFFERED=1" },
    { env: "PYTHONDONTWRITEBYTECODE=1" },
    { copy: "requirements.txt ." },
    { run: "pip install --no-cache-dir -r requirements.txt" },
    { copy: ". ." },
    { user: "1000:1000" },
    { cmd: ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"] },
  ],
});
```

## Root setup, then USER

```typescript
export const tool = new Dockerfile({
  from: "debian:12-slim",
  steps: [
    { run: "apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*" },
    { run: "useradd --system --create-home app" },
    { workdir: "/home/app" },
    { copy: "--chown=app:app bin/ ./bin/" },
    { user: "app" },
    { entrypoint: ["./bin/tool"] },
  ],
});
```

## Sharing stages and steps across modules

Export `const` stages and step lists from one module and import them into each Dockerfile. This is the chant answer to `INCLUDE`.

```typescript
// src/shared/node.ts
import type { DockerfileStage, DockerfileStep } from "@intentius/chant-lexicon-docker";

export const nodeBuild: DockerfileStage = {
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
};

export const nodeRuntime: DockerfileStep[] = [
  { workdir: "/app" },
  { copy: "--from=build /app/node_modules ./node_modules" },
  { copy: "--from=build /app/dist ./dist" },
  { user: "node" },
];
```

```typescript
// src/web.ts
import { Dockerfile, type DockerfileStage } from "@intentius/chant-lexicon-docker";
import { nodeBuild, nodeRuntime } from "./shared/node";

const runtime: DockerfileStage = {
  from: "node:20-alpine",
  steps: [...nodeRuntime, { expose: 3000 }, { cmd: ["node", "dist/server.js"] }],
};

export const web = new Dockerfile({ stages: [nodeBuild, runtime] });
```

For a shared Dockerfile that takes parameters, write a `Composite((props) => ({ image: new Dockerfile({...}) }))`; spreads are allowed inside it. The `dockerfile-sharing` example in the lexicon has all three patterns.

## Network isolation

```typescript
import { Service, Network } from "@intentius/chant-lexicon-docker";

export const internal = new Network({ driver: "bridge", internal: true });
export const external = new Network({ driver: "bridge" });

export const api = new Service({
  image: "myapi:1.0",
  networks: ["external", "internal"],
});
export const db = new Service({
  image: "postgres:16-alpine",
  networks: ["internal"],  // only reachable via internal network
});
```

## Secrets and configs

```typescript
import { Service, DockerSecret, DockerConfig } from "@intentius/chant-lexicon-docker";

export const dbPassword = new DockerSecret({ file: "./secrets/db-password.txt" });
export const appConfig = new DockerConfig({ file: "./config/app.yaml" });

export const app = new Service({
  image: "myapp:1.0",
  secrets: ["dbPassword"],
  configs: ["appConfig"],
});
```

## Environment interpolation patterns

```typescript
import { Service, env } from "@intentius/chant-lexicon-docker";

// Dev vs prod toggle:
export const api = new Service({
  image: env("API_IMAGE", { default: "myapp:latest" }),
  environment: {
    LOG_LEVEL: env("LOG_LEVEL", { default: "info" }),
    WORKERS: env("WORKERS", { default: "4" }),
    SECRET_KEY: env("SECRET_KEY", { required: true }),
    SENTRY_DSN: env("SENTRY_DSN", { default: "" }),
  },
});
```
