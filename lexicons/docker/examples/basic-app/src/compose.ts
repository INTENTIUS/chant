import { Service, Volume } from "@intentius/chant-lexicon-docker";

/**
 * PostgreSQL database service.
 */
export const db = new Service({
  image: "postgres:16-alpine",
  environment: {
    POSTGRES_DB: "myapp",
    POSTGRES_USER: "myapp",
    POSTGRES_PASSWORD: "secret",
  },
  volumes: ["pgdata:/var/lib/postgresql/data"],
  restart: "unless-stopped",
});

/**
 * Persistent data volume for PostgreSQL.
 */
export const pgdata = new Volume({});

/**
 * Application API service.
 */
export const api = new Service({
  image: "myapp:1.0",
  ports: ["8080:8080"],
  depends_on: ["db"],
  environment: {
    DATABASE_URL: "postgresql://myapp:secret@db:5432/myapp",
    NODE_ENV: "production",
  },
  restart: "unless-stopped",
  healthcheck: {
    test: ["CMD", "curl", "-f", "http://localhost:8080/health"],
    interval: "30s",
    timeout: "10s",
    retries: 3,
  },
});
