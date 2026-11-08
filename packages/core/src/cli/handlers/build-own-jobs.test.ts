/**
 * `chant build --components --generate <forge> --own-jobs <file>` and
 * `--keep-own-jobs` (#4769): the generated file carries the repository's
 * own jobs, and a build without either writes what it wrote before.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../parse-args";
import { setActiveProductWords } from "../../ci-product-words";

const generateComponentsPipelineMock = vi.fn();
vi.mock("../../components/cli-support", () => ({
  generateComponentsPipeline: (...args: unknown[]) => generateComponentsPipelineMock(...args),
}));
vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfigUpward: async () => ({ config: {} }) };
});
vi.mock("../plugins", async () => {
  const actual = await vi.importActual<typeof import("../plugins")>("../plugins");
  return { ...actual, resolveProjectLexicons: async () => [] };
});

const { runBuild } = await import("./build");

const GENERATED = ["name: chant", "jobs:", "  plan:", "    steps:", "      - run: npx --no-install plywood components pr-plan prod", ""].join("\n");

async function build(argv: string[]): Promise<{ code: number; err: string }> {
  const err: string[] = [];
  vi.spyOn(console, "error").mockImplementation((s: string) => void err.push(String(s)));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const code = await runBuild({ args: parseArgs(argv) } as never);
  return { code, err: err.join("\n") };
}

describe("build --own-jobs and --keep-own-jobs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chant-build-own-"));
    generateComponentsPipelineMock.mockReset().mockResolvedValue({ success: true, yaml: GENERATED, stages: [], jobs: [] });
  });

  test("without either flag the file is what the generator wrote", async () => {
    const out = join(dir, "ci.yml");
    expect((await build(["build", ".", "--components", "--generate", "github", "--output", out])).code).toBe(0);
    expect(readFileSync(out, "utf-8")).toBe(GENERATED);
  });

  test("--own-jobs merges the file's jobs after chant's, and refuses a collision", async () => {
    const out = join(dir, "ci.yml");
    writeFileSync(join(dir, "own.yml"), "lint:\n  runs-on: x\n");
    expect((await build(["build", ".", "--components", "--generate", "forgejo", "--own-jobs", join(dir, "own.yml"), "--output", out])).code).toBe(0);
    expect(readFileSync(out, "utf-8")).toMatch(/\n {2}# Your own jobs[^\n]*\n {2}lint:\n {4}runs-on: x\n$/);
    writeFileSync(join(dir, "bad.yml"), "plan:\n  runs-on: x\n");
    const refused = await build(["build", ".", "--components", "--generate", "forgejo", "--own-jobs", join(dir, "bad.yml"), "--output", join(dir, "other.yml")]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/plan: chant's file has a job of that name/);
  });

  test("--keep-own-jobs keeps the old file's hand-added job, and drops one that runs the product's bin", async () => {
    const out = join(dir, "ci.yml");
    writeFileSync(out, GENERATED + "  audit:\n    steps:\n      - run: npm audit\n  stale:\n    steps:\n      - run: npx --no-install plywood ci run drift\n");
    const before = setActiveProductWords({ product: "plywood", bin: "npx --no-install plywood" });
    try {
      expect((await build(["build", ".", "--components", "--generate", "github", "--keep-own-jobs", "--output", out])).code).toBe(0);
    } finally {
      setActiveProductWords(before);
    }
    const text = readFileSync(out, "utf-8");
    expect(text).toContain("  audit:\n    steps:\n      - run: npm audit\n");
    expect(text).not.toContain("stale:");
  });

  test("--keep-own-jobs needs a file to read, and the flags need generate mode", async () => {
    expect((await build(["build", ".", "--components", "--generate", "github", "--keep-own-jobs"])).err).toMatch(/needs --output/);
    expect(() => parseArgs(["build", ".", "--own-jobs", "own.yml"])).toThrow(/--own-jobs needs build --components --generate/);
  });
});
