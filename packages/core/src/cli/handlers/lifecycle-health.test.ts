import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockPlugin } from "@intentius/chant-test-utils";
import type { BuildResult } from "../../build";
import type { LexiconPlugin } from "../../lexicon";
import type { ParsedArgs } from "../registry";
import { HEALTH_SCHEMA_ID } from "../../health";
import { UNOBSERVED_REASONS } from "../../observation";
import { contract, validSchema } from "../../workspace/__fixtures__/contract-repo";
import schema from "../../health.schema.json";

const { expectValid, validate } = contract(schema);

const buildMock = vi.fn();
const loadChantConfigMock = vi.fn();
vi.mock("../../build", () => ({ build: (...args: unknown[]) => buildMock(...args) }));
vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args) };
});

const { runLifecycleHealth } = await import("./lifecycle-health");

function args(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return { command: "lifecycle", path: "health", format: "", fix: false, watch: false, verbose: false, help: false, extraPositional: "prod", ...overrides } as ParsedArgs;
}

function buildResult(entities: Array<[string, string, string]>): BuildResult {
  return {
    outputs: new Map([["aws", "{}"]]),
    entities: new Map(entities.map(([name, lexicon, entityType]) => [name, { lexicon, entityType, kind: "resource", props: {} }])),
    dependencies: new Map(),
    errors: [],
    warnings: [],
    manifest: { lexicons: ["aws"], outputs: {}, deployOrder: ["aws"] },
    sourceFileCount: 1,
  } as unknown as BuildResult;
}

describe("chant lifecycle health (#4177)", () => {
  let out: string[];
  let err: string[];
  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { out.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { err.push(s); });
    loadChantConfigMock.mockResolvedValue({ config: { environments: ["prod"] } });
    buildMock.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  test("asks only about the types the lexicon names, and prints chant-health/v1", async () => {
    buildMock.mockResolvedValue(buildResult([["web", "aws", "AWS::ECS::Service"], ["bucket", "aws", "AWS::S3::Bucket"]]));
    const asked: string[][] = [];
    const plugin: LexiconPlugin = {
      ...createMockPlugin({ name: "aws" }),
      healthTypes: ["AWS::ECS::Service"],
      observeHealth: async (o) => {
        asked.push([...o.entities.keys()]);
        return { entities: { web: { type: "AWS::ECS::Service", state: "unhealthy", detail: "0/2 running", observedAt: "t" } }, unobserved: {}, absent: [] };
      },
    };
    const exit = await runLifecycleHealth({ args: args({ json: true }), plugins: [plugin], serializers: [plugin.serializer] });
    expect(exit).toBe(0);
    expect(asked).toEqual([["web"]]);
    const json = JSON.parse(out[0]!);
    expect(json.schema).toBe("chant-health/v1");
    expect(typeof json.chantVersion).toBe("string");
    expect(json.lexicons.aws.entities.web.state).toBe("unhealthy");
    expect(json.summary).toEqual({ healthy: 0, unhealthy: 1, unknown: 0, unobserved: 0, absent: 0 });
    expectValid(json);
  });

  test("a reader that throws is not read, never unhealthy", async () => {
    buildMock.mockResolvedValue(buildResult([["web", "aws", "AWS::ECS::Service"]]));
    const plugin: LexiconPlugin = {
      ...createMockPlugin({ name: "aws" }),
      healthTypes: ["AWS::ECS::Service"],
      observeHealth: async () => {
        throw new Error("no route to host");
      },
    };
    await runLifecycleHealth({ args: args(), plugins: [plugin], serializers: [plugin.serializer] });
    expect(out.join("\n")).toContain("not read  web (AWS::ECS::Service): read-failed, no route to host");
    expect(err.join("\n")).toContain("0 healthy, 0 unhealthy, 0 unknown, 1 not observed");
  });

  test("refuses with no environment, and with no lexicon that reads health", async () => {
    const plain = createMockPlugin({ name: "aws" });
    expect(await runLifecycleHealth({ args: args({ extraPositional: undefined }), plugins: [plain], serializers: [] })).toBe(1);
    expect(await runLifecycleHealth({ args: args(), plugins: [plain], serializers: [] })).toBe(1);
    expect(err.join("\n")).toContain("No configured lexicon has a health read");
  });

  test("the JSON of a read that failed follows the schema", async () => {
    buildMock.mockResolvedValue(buildResult([["web", "aws", "AWS::ECS::Service"], ["gone", "aws", "AWS::ECS::Service"]]));
    const plugin: LexiconPlugin = {
      ...createMockPlugin({ name: "aws" }),
      healthTypes: ["AWS::ECS::Service"],
      observeHealth: async () => ({ entities: {}, unobserved: { web: { type: "AWS::ECS::Service", reason: "no-credentials", detail: "no AWS credentials" } }, absent: ["gone"] }),
    };
    await runLifecycleHealth({ args: args({ json: true }), plugins: [plugin], serializers: [plugin.serializer] });
    const json = JSON.parse(out[0]!);
    expect(json.summary).toEqual({ healthy: 0, unhealthy: 0, unknown: 0, unobserved: 1, absent: 1 });
    expectValid(json);
  });
});

describe("the chant-health/v1 schema (#4177)", () => {
  test("is a valid schema with the exported id, and names every unobserved reason", () => {
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(HEALTH_SCHEMA_ID);
    expect([...schema.$defs.hole.properties.reason.enum].sort()).toEqual([...UNOBSERVED_REASONS].sort());
  });

  test("a document with neither lexicons nor stacks, or a state outside the three, does not validate", () => {
    const base = { schema: "chant-health/v1", chantVersion: "0.124.33", environment: "prod", observedAt: "t", summary: { healthy: 0, unhealthy: 0, unknown: 0, unobserved: 0, absent: 0 } };
    expect(validate(base)).toBe(false);
    expectValid({ ...base, stacks: { east: {} } });
    const bad = { ...base, lexicons: { aws: { entities: { web: { type: "AWS::ECS::Service", state: "down", detail: "", observedAt: "t" } }, unobserved: {}, absent: [] } } };
    expect(validate(bad)).toBe(false);
  });
});
