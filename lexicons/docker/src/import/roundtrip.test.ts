import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { DockerParser, DockerfileParser } from "./parser";
import { DockerGenerator } from "./generator";
import { DockerTemplateGenerator, DockerTemplateParser } from "./adapter";
import { Dockerfile } from "../generated/index";
import { dockerSerializer } from "../serializer";
import type { Declarable } from "@intentius/chant/declarable";

/**
 * Dockerfile -> TypeScript -> Dockerfile. The generated source is run (its
 * import line dropped, its exports collected) and the entity it declares is
 * serialized again.
 */
function roundTrip(content: string, source?: string): { source: string; dockerfile: string } {
  const src = source ?? new DockerGenerator().generate([new DockerfileParser().parse("app", content)]).source;
  const body = src.replace(/^import .*$/m, "").replace(/export const (\w+) =/g, "out.$1 =");
  const out: Record<string, Declarable> = {};
  new Function("Dockerfile", "out", body)(Dockerfile, out);
  const result = dockerSerializer.serialize(new Map(Object.entries(out))) as { files: Record<string, string> };
  return { source: src, dockerfile: Object.values(result.files)[0]! };
}

const testdata = (file: string) =>
  readFileSync(join(import.meta.dirname, "testdata", file), "utf8");

describe("roundtrip: parse → generate", () => {
  test("simple.yaml → Service + Volume constructors", () => {
    const { entities } = new DockerParser().parse(testdata("simple.yaml"));
    const { source } = new DockerGenerator().generate(entities);
    expect(source).toContain("new Service(");
    expect(source).toContain("new Volume(");
    expect(source).toContain("nginx:1.25");
  });

  test("webapp.yaml → ports / healthcheck / depends_on survive roundtrip", () => {
    const { entities } = new DockerParser().parse(testdata("webapp.yaml"));
    const { source } = new DockerGenerator().generate(entities);
    expect(source).toContain("3000:3000");
    expect(source).toContain("depends_on");
    expect(source).toContain("healthcheck");
    expect(source).toContain("unless-stopped");
  });

  test("full.yaml → Config / Secret / Network constructors present", () => {
    const { entities } = new DockerParser().parse(testdata("full.yaml"));
    const { source } = new DockerGenerator().generate(entities);
    expect(source).toContain("new Config(");
    expect(source).toContain("new Secret(");
    expect(source).toContain("new Network(");
  });

  test("multi-stage Dockerfile inline → stages: in output", () => {
    const content = [
      "FROM node:20-alpine AS builder",
      "RUN npm ci",
      "FROM nginx:1.25 AS runner",
      "COPY --from=builder /app/dist /usr/share/nginx/html",
    ].join("\n");
    const entity = new DockerfileParser().parse("app", content);
    const { source } = new DockerGenerator().generate([entity]);
    expect(source).toContain("stages");
    expect(source).toContain("node:20-alpine");
    expect(source).toContain("nginx:1.25");
  });

});

describe("roundtrip: Dockerfile → TypeScript → Dockerfile keeps the instruction order", () => {
  test("interleaved COPY and RUN", () => {
    const content = [
      "FROM node:20-alpine",
      "WORKDIR /app",
      "COPY package*.json ./",
      "RUN npm ci",
      "COPY . .",
      "RUN npm run build",
      'CMD ["node", "dist/index.js"]',
      "",
    ].join("\n");
    const { source, dockerfile } = roundTrip(content);
    expect(source).toContain("steps: [");
    expect(dockerfile).toBe(content);
  });

  test("USER after RUN stays after it", () => {
    const content = [
      "FROM debian:12-slim",
      "RUN apt-get update && apt-get install -y --no-install-recommends curl",
      "RUN useradd --system app",
      "USER app",
      "RUN whoami",
      "",
    ].join("\n");
    expect(roundTrip(content).dockerfile).toBe(content);
  });

  test("multi-stage, ARG before FROM, SHELL, STOPSIGNAL, ONBUILD and repeated WORKDIR", () => {
    const content = [
      "ARG NODE_VERSION=20",
      "FROM node:${NODE_VERSION}-alpine AS build",
      'SHELL ["/bin/sh", "-c"]',
      "WORKDIR /src",
      "COPY . .",
      "WORKDIR /src/app",
      "RUN npm run build",
      "FROM nginx:1.27-alpine",
      "COPY --from=build /src/app/dist /usr/share/nginx/html",
      "ONBUILD COPY . /usr/share/nginx/html",
      "STOPSIGNAL SIGQUIT",
      "",
    ].join("\n");
    const { source, dockerfile } = roundTrip(content);
    expect(source).toContain('globalArgs: ["NODE_VERSION=20"]');
    expect(dockerfile).toBe(content);
  });

  test("line continuations and heredocs are kept as written", () => {
    const content = [
      "# syntax=docker/dockerfile:1",
      "FROM debian:12-slim",
      "RUN apt-get update \\",
      "    # a comment Docker drops",
      "    && apt-get install -y --no-install-recommends curl",
      "RUN <<EOF",
      "set -e",
      "echo hello > /hello",
      "EOF",
      "USER nobody",
      "",
    ].join("\n");
    const { dockerfile } = roundTrip(content);
    expect(dockerfile).toBe([
      "FROM debian:12-slim",
      "RUN apt-get update \\",
      "    && apt-get install -y --no-install-recommends curl",
      "RUN <<EOF",
      "set -e",
      "echo hello > /hello",
      "EOF",
      "USER nobody",
      "",
    ].join("\n"));
  });

  test("chant import of a Dockerfile goes through the template adapter", () => {
    const content = "FROM alpine:3.20\nCOPY run.sh /run.sh\nRUN chmod +x /run.sh\nUSER nobody\n";
    const ir = new DockerTemplateParser().parse(content);
    const [file] = new DockerTemplateGenerator().generate(ir);
    expect(file!.content).toContain("export const app = new Dockerfile({");
    expect(roundTrip(content, file!.content).dockerfile).toBe(content);
  });
});
