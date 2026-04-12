import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { DockerParser, DockerfileParser } from "./parser";
import { DockerGenerator } from "./generator";

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
