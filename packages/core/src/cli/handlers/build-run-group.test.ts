/**
 * `--run-group <key>` (#4771) reaches the generator's `runGroup`, on `chant
 * build --components --generate` and on `chant run --generate` with an op
 * waves spec, and a build without it passes no `runGroup`.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { parseArgs } from "../parse-args";

const generateComponentsPipelineMock = vi.fn(async () => ({ success: true, yaml: "x", stages: [], jobs: [] }));
const generateOpWavesPipelineMock = vi.fn(async () => ({ success: true, files: [], jobs: [] }));
vi.mock("../../components/cli-support", () => ({ generateComponentsPipeline: (...a: unknown[]) => generateComponentsPipelineMock(...(a as [])) }));
vi.mock("../../op/generate-pipeline", async () => {
  const actual = await vi.importActual<typeof import("../../op/generate-pipeline")>("../../op/generate-pipeline");
  return { ...actual, generateOpWavesPipeline: (...a: unknown[]) => generateOpWavesPipelineMock(...(a as [])) };
});
vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfigUpward: async () => ({ config: {} }) };
});
vi.mock("../plugins", async () => {
  const actual = await vi.importActual<typeof import("../plugins")>("../plugins");
  return { ...actual, resolveProjectLexicons: async () => [] };
});

const { runBuild } = await import("./build");
const { runOpGenerate } = await import("./run-generate");

describe("--run-group", () => {
  test("takes commit or pull-request", () => {
    expect(parseArgs(["build", ".", "--components", "--generate", "forgejo", "--run-group", "pull-request"]).runGroup).toBe("pull-request");
    expect(() => parseArgs(["build", "--run-group", "branch"])).toThrow(/--run-group takes commit or pull-request/);
  });

  test("build passes it to the generator, and passes none without it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runBuild({ args: parseArgs(["build", ".", "--components", "--generate", "forgejo", "--run-group", "pull-request"]) } as never);
    expect((generateComponentsPipelineMock.mock.calls[0] as unknown[])[2]).toMatchObject({ runGroup: "pull-request" });
    await runBuild({ args: parseArgs(["build", ".", "--components", "--generate", "forgejo"]) } as never);
    expect((generateComponentsPipelineMock.mock.calls[1] as unknown[])[2]).not.toHaveProperty("runGroup");
  });

  test("run --generate passes it with an op waves spec", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-run-group-"));
    const spec = join(dir, "waves.json");
    writeFileSync(spec, JSON.stringify({ name: "w", op: "o", plan: ["p"], waves: [{ name: "a", runs: [{ target: "a" }] }] }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runOpGenerate({ args: parseArgs(["run", "--generate", "forgejo", "--spec", spec, "--run-group", "commit", "--output", dir]) } as never);
    expect((generateOpWavesPipelineMock.mock.calls[0] as unknown[])[2]).toMatchObject({ runGroup: "commit" });
  });
});

test("FORGEJO_RUN_GROUP_FLOOR marks it in the ci-product entry", async () => {
  const ciProduct = await import("../../ci-product");
  expect(ciProduct.FORGEJO_RUN_GROUP_FLOOR).toBe("0.124.77");
  expect(ciProduct.RUN_GROUP_KEYS).toEqual(["commit", "pull-request"]);
});
