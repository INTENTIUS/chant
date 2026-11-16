/**
 * Prow's own strict config loader takes what chant builds.
 *
 * The loader (`config.LoadStrict`, what checkconfig --strict runs) is
 * sigs.k8s.io/prow at the version tools/go.mod pins, whose go.sum holds the
 * module's hash, run from Go's module cache with GOPROXY=off, so a test run
 * never downloads it. tools/check also makes the ProwJob Prow would create
 * for each job, which the vendored CRD spec schema then checks. Skipped where
 * Go or the pinned module is not there; fetch it once with
 * `go mod download` in lexicons/prow/tools.
 *
 * The loader's refusals are the positive fixtures of PROW101 to PROW103 and PROW106, so the
 * checks and the loader agree on them. It also loads what `chant build
 * --components --generate prow` writes for a component project, and what the
 * prow generators write for each kind of job chant generates for GitHub
 * (#5189).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import Ajv from "ajv";
import { prowJobSpecSchema } from "./spec/schema";
import { fixture, TESTDATA } from "./testdata/build";
import { builtConfigs } from "./testdata/built-configs";
import { generatedConfigs } from "./testdata/generated-configs";

const CHANT = join(TESTDATA, "..", "..", "..", "..", "packages", "core", "bin", "chant");

/**
 * `chant build --components --generate prow` in a component project of its
 * own: a new git repository whose origin remote names acme/app on GitHub,
 * outside this checkout, so the build reads that remote and writes nothing
 * here.
 */
function cliConfig(flags: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-prow-generate-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/app.git"], { cwd: dir });
  const step = '[{ phase: "Apply", steps: [{ kind: "shell", reason: "t" }] }]';
  writeFileSync(join(dir, "db.component.ts"), `export const db = { name: "db", dependsOn: [], deploy: ${step} };\n`);
  writeFileSync(join(dir, "api.component.ts"), `export const api = { name: "api", dependsOn: ["db"], deploy: ${step} };\n`);
  execFileSync("node", [CHANT, "build", ".", "--components", "--generate", "prow", "--env", "prod", ...flags, "-o", "jobs.yaml"], { cwd: dir, stdio: ["ignore", "ignore", "pipe"], timeout: 300_000 });
  return readFileSync(join(dir, "jobs.yaml"), "utf-8");
}

const TOOLS = join(TESTDATA, "..", "..", "tools");
const PROW_CONFIG = join(TESTDATA, "prow-config.yaml");
const OFFLINE = { ...process.env, GOFLAGS: "-mod=mod", GOPROXY: "off", GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? "auto" };

const prowCached = ((): boolean => {
  if (spawnSync("go", ["version"], { encoding: "utf-8" }).status !== 0) return false;
  return spawnSync("go", ["list", "-m", "-f", "{{.Dir}}", "sigs.k8s.io/prow"], { cwd: TOOLS, env: OFFLINE, encoding: "utf-8" }).status === 0;
})();

function load(jobs: string): { status: number | null; out: string; err: string } {
  const file = join(mkdtempSync(join(tmpdir(), "chant-prow-")), "jobs.yaml");
  writeFileSync(file, jobs);
  const r = spawnSync("go", ["run", "./check", PROW_CONFIG, file], { cwd: TOOLS, env: OFFLINE, encoding: "utf-8", timeout: 600_000 });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const prowJobSpec = new Ajv({ strict: false, allErrors: true }).compile(prowJobSpecSchema());

describe.skipIf(!prowCached)("Prow's own strict config loader", () => {
  test("loads every job chant builds and makes ProwJobs the CRD schema takes", async () => {
    const want: Record<string, string[]> = {
      authored: ["periodic periodic-app-e2e trusted", "postsubmit post-app-publish trusted", "presubmit pull-app-lint untrusted", "presubmit pull-app-unit untrusted"],
      "terragucci full, imported and built": [
        "periodic terragucci-drift trusted",
        "postsubmit terragucci-apply trusted",
        "postsubmit terragucci-plan trusted",
        "presubmit terragucci-check untrusted",
        "presubmit terragucci-plan trusted",
      ],
    };
    for (const [what, text] of await builtConfigs()) {
      const r = load(text);
      expect({ what, err: r.err, status: r.status }).toEqual({ what, err: "", status: 0 });
      const made = r.out.trim().split("\n").map((l) => JSON.parse(l) as { spec: Record<string, unknown> & { job: string; type: string; cluster: string } });
      expect(made.map((j) => `${j.spec.type} ${j.spec.job} ${j.spec.cluster}`).sort()).toEqual(want[what]);
      for (const j of made) expect({ job: j.spec.job, ok: prowJobSpec(j.spec), errors: prowJobSpec.errors }).toEqual({ job: j.spec.job, ok: true, errors: null });
    }
  }, 600_000);

  test("loads the job config chant build --components --generate prow writes for a component project (#5189)", () => {
    const want: Record<string, string[]> = {
      "deploy pipeline": ["postsubmit chant-components-prod trusted"],
      "pull request loop": ["postsubmit chant-apply-prod trusted", "postsubmit chant-record-prod trusted", "postsubmit chant-stale-notes-prod trusted", "presubmit chant-check-prod untrusted", "presubmit chant-plan-prod untrusted"],
    };
    const cli: Array<[string, string]> = [
      ["deploy pipeline", cliConfig([])],
      ["pull request loop", cliConfig(["--pr-loop", "--apply-on-merge", "--wave-gate", "pr-apply", "--check-job", "--stale-notes"])],
    ];
    for (const [what, text] of cli) {
      expect(text.startsWith("# Written by chant build --components --generate prow for acme/app, environment prod.\n")).toBe(true);
      const r = load(text);
      expect({ what, err: r.err, status: r.status }).toEqual({ what, err: "", status: 0 });
      const made = r.out.trim().split("\n").map((l) => JSON.parse(l) as { spec: Record<string, unknown> & { job: string; type: string; cluster: string } });
      expect({ what, jobs: made.map((j) => `${j.spec.type} ${j.spec.job} ${j.spec.cluster}`).sort() }).toEqual({ what, jobs: want[what] });
      for (const j of made) expect({ job: j.spec.job, ok: prowJobSpec(j.spec), errors: prowJobSpec.errors }).toEqual({ job: j.spec.job, ok: true, errors: null });
    }
  }, 900_000);

  test("loads the job config the prow generators write for each kind of job chant generates for GitHub (#5189)", () => {
    for (const [what, text] of generatedConfigs()) {
      const r = load(text);
      expect({ what, err: r.err, status: r.status }).toEqual({ what, err: "", status: 0 });
      const made = r.out.trim().split("\n").map((l) => JSON.parse(l) as { spec: Record<string, unknown> & { job: string } });
      expect(made.length).toBeGreaterThan(0);
      for (const j of made) expect({ what, job: j.spec.job, ok: prowJobSpec(j.spec), errors: prowJobSpec.errors }).toEqual({ what, job: j.spec.job, ok: true, errors: null });
    }
  }, 900_000);

  test("refuses what PROW101, PROW102, PROW103 and PROW106 flag, and a field it does not know", () => {
    for (const [id, needle] of [
      ["PROW101", "duplicated presubmit jobs"],
      ["PROW102", "at least one of cron, interval, or minimum_interval must be set"],
      ["PROW103", "kubernetes jobs require a spec"],
      ["PROW106", "is set to always run but also declares skip_if_only_changed targets"],
    ] as const) {
      const r = load(fixture(`../lint/post-synth/fixtures/${id}/positive.yaml`));
      expect({ id, status: r.status }).toEqual({ id, status: 1 });
      expect(r.err).toContain(needle);
      expect({ id, negative: load(fixture(`../lint/post-synth/fixtures/${id}/negative.yaml`)).status }).toEqual({ id, negative: 0 });
    }
    const unknown = load(fixture("terragucci/default.yaml").replace("always_run: true", "always_run: true\n      run_always: true"));
    expect(unknown.status).toBe(1);
    expect(unknown.err).toContain("unknown field");
  }, 600_000);
});
