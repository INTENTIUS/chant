import { describe, test, expect, mock } from "bun:test";
import { generate, writeGeneratedFiles } from "./generate";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock the network fetches so tests run offline and fast
mock.module("../spec/fetch-compose", () => ({
  fetchComposeSpec: async () => Buffer.from("{}"),
}));

mock.module("../spec/fetch-engine", () => ({
  fetchEngineApi: async () => Buffer.from("{}"),
}));

describe("generate()", () => {
  test("returns a GenerateResult with correct shape", async () => {
    const result = await generate({ verbose: false });

    expect(result).toBeDefined();
    expect(typeof result.resources).toBe("number");
    expect(typeof result.properties).toBe("number");
    expect(typeof result.enums).toBe("number");
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(typeof result.lexiconJSON).toBe("string");
    expect(typeof result.typesDTS).toBe("string");
    expect(typeof result.indexTS).toBe("string");
  });

  test("generates all 6 entity types", async () => {
    const result = await generate({ verbose: false });
    expect(result.resources).toBe(6); // 5 Compose + 1 Dockerfile
  });

  test("lexiconJSON includes all entity class names", async () => {
    const result = await generate({ verbose: false });
    const json = JSON.parse(result.lexiconJSON);

    expect(json.Service).toBeDefined();
    expect(json.Volume).toBeDefined();
    expect(json.Network).toBeDefined();
    expect(json.DockerConfig).toBeDefined();
    expect(json.DockerSecret).toBeDefined();
    expect(json.Dockerfile).toBeDefined();
  });

  test("lexiconJSON entries have resourceType and kind", async () => {
    const result = await generate({ verbose: false });
    const json = JSON.parse(result.lexiconJSON);

    expect(json.Service.resourceType).toBe("Docker::Compose::Service");
    expect(json.Service.kind).toBe("resource");
    expect(json.Dockerfile.resourceType).toBe("Docker::Dockerfile");
  });

  test("indexTS exports all entity names", async () => {
    const result = await generate({ verbose: false });
    expect(result.indexTS).toContain("export const Service");
    expect(result.indexTS).toContain("export const Dockerfile");
    expect(result.indexTS).toContain('createResource("Docker::Compose::Service"');
  });

  test("typesDTS declares all entity interfaces", async () => {
    const result = await generate({ verbose: false });
    expect(result.typesDTS).toContain("interface ServiceProps");
    expect(result.typesDTS).toContain("interface DockerfileProps");
    expect(result.typesDTS).toContain("declare const Service");
  });

  test("properties count is non-zero", async () => {
    const result = await generate({ verbose: false });
    expect(result.properties).toBeGreaterThan(0);
  });
});

describe("writeGeneratedFiles()", () => {
  const tmpDir = join(tmpdir(), `chant-docker-test-${Date.now()}`);

  test("writes all expected files to src/generated/", async () => {
    mkdirSync(join(tmpDir, "src", "generated"), { recursive: true });

    const result = await generate({ verbose: false });
    writeGeneratedFiles(result, tmpDir);

    expect(existsSync(join(tmpDir, "src", "generated", "lexicon-docker.json"))).toBe(true);
    expect(existsSync(join(tmpDir, "src", "generated", "index.ts"))).toBe(true);
    expect(existsSync(join(tmpDir, "src", "generated", "index.d.ts"))).toBe(true);
    expect(existsSync(join(tmpDir, "src", "generated", "runtime.ts"))).toBe(true);

    // Clean up
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("lexicon-docker.json is valid JSON", async () => {
    mkdirSync(join(tmpDir, "src", "generated"), { recursive: true });

    const result = await generate({ verbose: false });
    writeGeneratedFiles(result, tmpDir);

    const json = readFileSync(join(tmpDir, "src", "generated", "lexicon-docker.json"), "utf-8");
    expect(() => JSON.parse(json)).not.toThrow();

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
