import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { DockerParser, DockerfileParser } from "./parser";

const testdata = (file: string) =>
  readFileSync(join(import.meta.dirname, "testdata", file), "utf8");

describe("DockerParser — services", () => {
  test("image extracted correctly", () => {
    const yaml = `services:\n  api:\n    image: nginx:1.25\n`;
    const { entities } = new DockerParser().parse(yaml);
    const svc = entities.find((e) => e.name === "api");
    expect(svc?.kind).toBe("service");
    expect((svc?.props as any).image).toBe("nginx:1.25");
  });

  test("ports array preserved", () => {
    const yaml = `services:\n  web:\n    image: nginx:1.25\n    ports:\n      - "80:80"\n      - "443:443"\n`;
    const { entities } = new DockerParser().parse(yaml);
    const svc = entities.find((e) => e.name === "web");
    expect((svc?.props as any).ports).toEqual(["80:80", "443:443"]);
  });

  test("environment map preserved", () => {
    const yaml = `services:\n  app:\n    image: node:20\n    environment:\n      NODE_ENV: production\n      PORT: "3000"\n`;
    const { entities } = new DockerParser().parse(yaml);
    const svc = entities.find((e) => e.name === "app");
    expect((svc?.props as any).environment).toEqual({ NODE_ENV: "production", PORT: "3000" });
  });

  test("volumes list preserved", () => {
    const yaml = `services:\n  db:\n    image: postgres:16\n    volumes:\n      - "pg-data:/var/lib/postgresql/data"\n`;
    const { entities } = new DockerParser().parse(yaml);
    const svc = entities.find((e) => e.name === "db");
    expect((svc?.props as any).volumes).toEqual(["pg-data:/var/lib/postgresql/data"]);
  });

  test("depends_on list preserved", () => {
    const yaml = `services:\n  api:\n    image: node:20\n    depends_on:\n      - db\n      - cache\n`;
    const { entities } = new DockerParser().parse(yaml);
    const svc = entities.find((e) => e.name === "api");
    expect((svc?.props as any).depends_on).toEqual(["db", "cache"]);
  });

  test("restart string preserved", () => {
    const yaml = `services:\n  app:\n    image: myapp:latest\n    restart: unless-stopped\n`;
    const { entities } = new DockerParser().parse(yaml);
    const svc = entities.find((e) => e.name === "app");
    expect((svc?.props as any).restart).toBe("unless-stopped");
  });

  test("healthcheck object preserved", () => {
    const { entities } = new DockerParser().parse(testdata("webapp.yaml"));
    const svc = entities.find((e) => e.name === "api");
    const hc = (svc?.props as any).healthcheck;
    expect(hc).toBeDefined();
    expect(hc.interval).toBe("30s");
    expect(hc.retries).toBe(3);
  });
});

describe("DockerParser — top-level sections", () => {
  test("top-level volumes: section → VolumeIR entities", () => {
    const { entities } = new DockerParser().parse(testdata("simple.yaml"));
    const vol = entities.find((e) => e.kind === "volume" && e.name === "webdata");
    expect(vol).toBeDefined();
    expect((vol?.props as any).driver).toBe("local");
  });

  test("top-level networks: section → NetworkIR entities", () => {
    const { entities } = new DockerParser().parse(testdata("full.yaml"));
    const net = entities.find((e) => e.kind === "network" && e.name === "backend");
    expect(net).toBeDefined();
    expect((net?.props as any).driver).toBe("bridge");
  });

  test("top-level configs: section → ConfigIR entities", () => {
    const { entities } = new DockerParser().parse(testdata("full.yaml"));
    const cfg = entities.find((e) => e.kind === "config" && e.name === "app-config");
    expect(cfg).toBeDefined();
    expect((cfg?.props as any).file).toBe("./config/app.conf");
  });

  test("top-level secrets: section → SecretIR entities", () => {
    const { entities } = new DockerParser().parse(testdata("full.yaml"));
    const sec = entities.find((e) => e.kind === "secret" && e.name === "db-password");
    expect(sec).toBeDefined();
    expect((sec?.props as any).file).toBe("./secrets/db-password.txt");
  });

  test("returns empty entities for empty compose", () => {
    const result = new DockerParser().parse("");
    expect(result.entities).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

describe("DockerfileParser", () => {
  test("single-stage: stages[0].from correct", () => {
    const content = `FROM node:20-alpine\nRUN npm ci\nCMD ["node", "index.js"]\n`;
    const result = new DockerfileParser().parse("builder", content);
    expect(result.kind).toBe("dockerfile");
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].from).toBe("node:20-alpine");
  });

  test("multi-stage: two stages with correct from/as", () => {
    const content = [
      "FROM node:20-alpine AS builder",
      "RUN npm ci",
      "FROM nginx:1.25 AS runner",
      "COPY --from=builder /app/dist /usr/share/nginx/html",
    ].join("\n");
    const result = new DockerfileParser().parse("app", content);
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0].from).toBe("node:20-alpine");
    expect(result.stages[0].as).toBe("builder");
    expect(result.stages[1].from).toBe("nginx:1.25");
    expect(result.stages[1].as).toBe("runner");
  });

  test("parses multiple instructions within a stage", () => {
    const content = `FROM ubuntu:22.04\nRUN apt-get update\nCOPY . /app\nWORKDIR /app\n`;
    const result = new DockerfileParser().parse("app", content);
    expect(result.stages[0].instructions.length).toBeGreaterThanOrEqual(2);
    const runInstr = result.stages[0].instructions.find((i) => i.instruction === "RUN");
    expect(runInstr?.value).toBe("apt-get update");
  });

  test("skips comments and blank lines", () => {
    const content = `# This is a comment\nFROM alpine:3.18\n\n# Another comment\nRUN echo hello\n`;
    const result = new DockerfileParser().parse("test", content);
    expect(result.stages[0].from).toBe("alpine:3.18");
    expect(result.stages[0].instructions).toHaveLength(1);
  });
});
