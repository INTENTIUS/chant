/**
 * `chant run --generate <provider>` (#2533). Discovery is stubbed so the
 * scheduled Ops are fixed; the github, gitlab and forgejo lexicon plugins are
 * the real ones, so "identical to calling `generateOpsPipeline` directly" is
 * checked against the real generators.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../registry";
import type { OpConfig } from "../../op/types";

const discovered = new Map<string, { config: Partial<OpConfig>; filePath: string; exportName: string }>();

vi.mock("../../op/discover", () => ({
  discoverOps: async () => ({ ops: discovered, errors: [] }),
}));

const { runOp } = await import("./run");
const { generateOpsPipeline } = await import("../../op/generate-pipeline");
const { GENERATED_MARKER } = await import("../../discovery/files");
const { parseArgs } = await import("../main");

function ctx(argv: string[]) {
  const args = parseArgs(argv) as ParsedArgs;
  return { args, plugins: [], serializers: [] };
}

let dir: string;
let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-run-generate-"));
  discovered.clear();
  discovered.set("nightly-audit", {
    config: { name: "nightly-audit", phases: [], schedule: { cron: "0 6 * * *" } } as Partial<OpConfig>,
    filePath: "nightly-audit.op.ts",
    exportName: "default",
  });
  discovered.set("weekly-report", {
    config: { name: "weekly-report", phases: [], schedule: { cron: "0 7 * * 1" } } as Partial<OpConfig>,
    filePath: "weekly-report.op.ts",
    exportName: "default",
  });
  discovered.set("deploy", {
    config: { name: "deploy", phases: [] } as Partial<OpConfig>,
    filePath: "deploy.op.ts",
    exportName: "default",
  });
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  logSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe("chant run --generate <provider>", () => {
  test.each(["github", "gitlab", "forgejo"])(
    "%s: each file is the generator's own output under one marker line",
    async (provider) => {
      const out = join(dir, provider);
      expect(await runOp(ctx(["run", "--generate", provider, "--output", out]))).toBe(0);

      const direct = await generateOpsPipeline([{ name: "nightly-audit" }, { name: "weekly-report" }], provider);
      expect(direct.success).toBe(true);
      const header = `# ${GENERATED_MARKER}. Regenerate with: chant run --generate ${provider}\n`;

      expect(readdirSync(out).sort()).toEqual(direct.files!.map((f) => f.name).sort());
      for (const file of direct.files!) {
        expect(readFileSync(join(out, file.name), "utf-8")).toBe(header + file.yaml);
      }
    },
  );

  test("github and forgejo get one file per scheduled Op; an Op with no schedule is left out", async () => {
    for (const provider of ["github", "forgejo"]) {
      const out = join(dir, provider);
      expect(await runOp(ctx(["run", "--generate", provider, "--output", out]))).toBe(0);
      expect(readdirSync(out).sort()).toEqual(["nightly-audit.yml", "weekly-report.yml"]);
    }
  });

  test("each github (#2580) and forgejo (#2601) workflow is named after its Op", async () => {
    for (const provider of ["github", "forgejo"]) {
      expect(await runOp(ctx(["run", "--generate", provider, "--output", join(dir, provider)]))).toBe(0);
      const header = `# ${GENERATED_MARKER}. Regenerate with: chant run --generate ${provider}\n`;
      for (const op of ["nightly-audit", "weekly-report"]) {
        const written = readFileSync(join(dir, provider, `${op}.yml`), "utf-8");
        expect(written.startsWith(`${header}name: ${op}\n\non:\n`)).toBe(true);
      }
    }
  });

  test("--spec passes its ops and options to the generator unchanged", async () => {
    const specFile = join(dir, "ops.json");
    const spec = {
      ops: [
        { name: "deploy", trigger: { kind: "pull_request", branches: ["main"] }, findingMode: "comment" },
        { name: "nightly-audit" },
      ],
      options: { opsStage: "chant" },
    };
    writeFileSync(specFile, JSON.stringify(spec));
    const out = join(dir, "gitlab");
    expect(await runOp(ctx(["run", "--generate", "gitlab", "--spec", specFile, "--output", out]))).toBe(0);

    const direct = await generateOpsPipeline(spec.ops as never, "gitlab", spec.options);
    expect(direct.files!.map((f) => f.name)).toEqual(["chant.gitlab-ci.yml"]);
    const written = readFileSync(join(out, "chant.gitlab-ci.yml"), "utf-8");
    expect(written).toBe(
      `# ${GENERATED_MARKER}. Regenerate with: chant run --generate gitlab --spec ${specFile}\n` + direct.files![0].yaml,
    );
    expect(written).toContain('$CI_PIPELINE_SOURCE == "merge_request_event"');
  });

  test("--format json prints the files and jobs and writes nothing", async () => {
    const out = join(dir, "none");
    expect(await runOp(ctx(["run", "--generate", "github", "--output", out, "--format", "json"]))).toBe(0);
    const printed = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(printed.files.map((f: { path: string }) => f.path)).toEqual([
      join(out, "nightly-audit.yml"),
      join(out, "weekly-report.yml"),
    ]);
    expect(printed.files[0].content.startsWith(`# ${GENERATED_MARKER}`)).toBe(true);
    expect(printed.jobs).toHaveLength(2);
    expect(() => readdirSync(out)).toThrow();
  });

  test("with no scheduled Op and no --spec, it fails and says what to do", async () => {
    discovered.delete("nightly-audit");
    discovered.delete("weekly-report");
    expect(await runOp(ctx(["run", "--generate", "github", "--output", dir]))).toBe(1);
    expect(String(errSpy.mock.calls.flat().join("\n"))).toMatch(/No Op declares a schedule/);
  });

  test("a provider with no Op generator fails by name", async () => {
    expect(await runOp(ctx(["run", "--generate", "aws", "--output", dir]))).toBe(1);
    expect(String(errSpy.mock.calls.flat().join("\n"))).toMatch(/does not support Op generate mode/);
  });

  test("a --spec entry without a name is refused", async () => {
    const specFile = join(dir, "bad.json");
    writeFileSync(specFile, JSON.stringify([{ trigger: { kind: "push" } }]));
    expect(await runOp(ctx(["run", "--generate", "github", "--spec", specFile, "--output", dir]))).toBe(1);
    expect(String(errSpy.mock.calls.flat().join("\n"))).toMatch(/entry 0 has no "name"/);
  });

  test("--components with --generate on run is refused", async () => {
    expect(await runOp(ctx(["run", "--components", "--generate", "github"]))).toBe(1);
    expect(String(errSpy.mock.calls.flat().join("\n"))).toMatch(/build --components --generate/);
  });
});
