# chant-docker-patterns

Common Docker Compose and Dockerfile patterns using `@intentius/chant-lexicon-docker`.

## Database service with volume

```typescript
import { Service, Volume } from "@intentius/chant-lexicon-docker";

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

```typescript
export const nodeApp = new Dockerfile({
  stages: [
    {
      from: "node:20-alpine",
      as: "deps",
      workdir: "/app",
      copy: ["package*.json ./"],
      run: ["npm ci --only=production"],
    },
    {
      from: "node:20-alpine",
      as: "build",
      workdir: "/app",
      copy: ["--from=deps /app/node_modules ./node_modules", ". ."],
      run: ["npm run build"],
    },
    {
      from: "node:20-alpine",
      workdir: "/app",
      copy: [
        "--from=deps /app/node_modules ./node_modules",
        "--from=build /app/dist ./dist",
      ],
      user: "node",
      expose: ["3000"],
      cmd: `["node", "dist/index.js"]`,
    },
  ],
});
```

## Python service with virtualenv

```typescript
export const pythonApp = new Dockerfile({
  from: "python:3.12-slim",
  workdir: "/app",
  env: ["PYTHONUNBUFFERED=1", "PYTHONDONTWRITEBYTECODE=1"],
  copy: ["requirements.txt ."],
  run: [
    "pip install --no-cache-dir --no-deps -r requirements.txt",
  ],
  copy: [". ."],
  user: "1000:1000",
  cmd: `["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]`,
});
```

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
import { env } from "@intentius/chant-lexicon-docker";

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
