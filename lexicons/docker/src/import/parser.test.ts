import { describe, test, expect } from "bun:test";
import { DockerParser, DockerfileParser } from "./parser";

describe("DockerParser", () => {
  test("parses a simple docker-compose.yml", () => {
    const yaml = `services:\n  api:\n    image: nginx:1.25\n  db:\n    image: postgres:16\n`;
    const parser = new DockerParser();
    const result = parser.parse(yaml);

    expect(result.entities.length).toBeGreaterThanOrEqual(1);
    const service = result.entities.find((e) => e.name === "api");
    expect(service).toBeDefined();
    expect(service?.kind).toBe("service");
  });

  test("returns empty entities for empty compose", () => {
    const result = new DockerParser().parse("");
    expect(result.entities).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

describe("DockerfileParser", () => {
  test("parses FROM instruction", () => {
    const content = `FROM node:20-alpine\nRUN npm ci\nCMD ["node", "index.js"]\n`;
    const result = new DockerfileParser().parse("builder", content);

    expect(result.kind).toBe("dockerfile");
    expect(result.name).toBe("builder");
    expect(result.from).toBe("node:20-alpine");
  });

  test("parses multiple instructions", () => {
    const content = `FROM ubuntu:22.04\nRUN apt-get update\nCOPY . /app\nWORKDIR /app\n`;
    const result = new DockerfileParser().parse("app", content);

    expect(result.instructions.length).toBeGreaterThanOrEqual(2);
    const runInstr = result.instructions.find((i) => i.instruction === "RUN");
    expect(runInstr?.value).toBe("apt-get update");
  });

  test("skips comments and blank lines", () => {
    const content = `# This is a comment\nFROM alpine:3.18\n\n# Another comment\nRUN echo hello\n`;
    const result = new DockerfileParser().parse("test", content);

    expect(result.from).toBe("alpine:3.18");
    expect(result.instructions).toHaveLength(1);
  });
});
