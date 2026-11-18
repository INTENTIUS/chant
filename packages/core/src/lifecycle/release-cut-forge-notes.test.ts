/**
 * #5319: a cut refuses a forge target whose notes file has no heading for the
 * label, before it records anything, so no tag is made for a release the
 * publish would refuse.
 */
import { afterAll, describe, expect, test } from "vitest";
import { dirname } from "node:path";
import { rmSync } from "node:fs";
import { cutRelease, ReleaseCutError } from "./release-cut";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import type { ReleaseArtifact } from "./release-store";
import { TestRepo } from "../workspace/trust/test-repo";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const compiler: TargetCompiler = {
  async compile(env): Promise<CompiledTarget> {
    return { env, params: [], components: [], buildSteps: {}, buildInputs: {}, componentFiles: {}, templates: [{ component: null, path: "dist/out.json", content: "{}\n" }] };
  },
  async buildArtifacts(): Promise<ReleaseArtifact[]> {
    return [];
  },
};

const repo = (changelog: string | null) => {
  const r = new TestRepo("cut-forge-notes");
  repos.push(r);
  r.write(
    "chant.config.ts",
    `export default { environments: ["dev"], release: { publish: [{ type: "forge", forge: "github", repo: "acme/app", assets: [], notes: { file: "CHANGELOG.md", heading: "## [{version}]" } }] } };\n`,
  );
  if (changelog !== null) r.write("CHANGELOG.md", changelog);
  const head = r.commit("init");
  r.git(["tag", `ci/green/${head}`]);
  return r;
};

describe("the cut and a forge notes file", () => {
  test("refuses a label the file has no heading for, before anything is recorded", async () => {
    const r = repo("# Changelog\n\n## [0.6.3]\n\n- older\n");
    const err = await cutRelease({ cwd: r.dir, compiler, label: "v0.6.4", actor: "alice", env: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseCutError);
    expect((err as ReleaseCutError).code).toBe("publish-forge-notes-missing");
    expect((err as ReleaseCutError).message).toMatch(/^no release was cut: the github release's notes come from CHANGELOG.md, and it has no heading "## \[0.6.4\]"/);
    expect((err as ReleaseCutError).fix).toBe('Write the "## [0.6.4]" section in CHANGELOG.md, or change notes.heading.');
    expect(() => r.git(["rev-parse", "--verify", "--quiet", "refs/heads/chant/lifecycle"])).toThrow();
  });

  test("refuses when the file does not exist", async () => {
    const r = repo(null);
    const err = await cutRelease({ cwd: r.dir, compiler, label: "v0.6.4", actor: "alice", env: {} }).catch((e: unknown) => e);
    expect((err as ReleaseCutError).code).toBe("publish-forge-notes-missing");
    expect((err as ReleaseCutError).message).toContain("CHANGELOG.md does not exist");
  });

  test("cuts a label the file has a heading for", async () => {
    const r = repo("# Changelog\n\n## [0.6.4] - 2026-11-18\n\n- fixed\n");
    const out = await cutRelease({ cwd: r.dir, compiler, label: "v0.6.4", actor: "alice", env: {} });
    expect(out.label).toBe("v0.6.4");
  });
});
