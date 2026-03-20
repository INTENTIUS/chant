import { Service, Volume } from "@intentius/chant-lexicon-docker";

// Local PostgreSQL mirroring the production RDS configuration.
// Run with: docker compose up -d
// Then apply migrations: npx flyway -url=jdbc:postgresql://localhost:5432/myapp migrate

export const postgres = new Service({
  image: "postgres:16-alpine",
  environment: {
    POSTGRES_DB: "myapp",
    POSTGRES_USER: "postgres",
    POSTGRES_PASSWORD: "localdev",
  },
  ports: ["5432:5432"],
  volumes: ["pgdata:/var/lib/postgresql/data"],
  restart: "unless-stopped",
});

export const pgdata = new Volume({});
