/**
 * `chant ci init` (#4168 step 6): the proposal, its diff and the write, and
 * `chant release workflow`'s rendering.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { applyCiInit, componentStub, editDeclarationText, inferGreen, lineDiff, proposeCiInit, withEnvironments } from "./ci-init";
import { publishFlags, renderReleaseWorkflow } from "./release-workflow";
import { runDeclarationChecks } from "./checks";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-ci-init-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const DECLARATION = `${JSON.stringify({ name: "acme", schema: 1, members: [{ name: "api", dir: "api", kind: "other", because: "the service" }] }, null, 2)}\n`;
const CHECK_YML = "name: check\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps: []\n  test:\n    runs-on: ubuntu-latest\n    steps: []\n";
const SUITES_YML = "name: suites\non:\n  push:\n    branches: [main]\njobs:\n  e2e:\n    runs-on: ubuntu-latest\n    steps: []\n";

const fresh = () =>
  repo({
    "chant.workspace.json": DECLARATION,
    "api/chant.config.ts": 'export default {\n  lexicons: ["aws"],\n};\n',
    ".github/workflows/check.yml": CHECK_YML,
    ".github/workflows/suites.yml": SUITES_YML,
  });

describe("proposeCiInit", () => {
  test("a fresh workspace gets ci.workflow, an inferred ci.green, environments, a component stub and the generators", () => {
    const root = fresh();
    const p = proposeCiInit(root, { workflow: "trunk-curated" });
    expect(p.files.map((f) => [f.path, f.before === null ? "new" : "edit"])).toEqual([
      ["chant.workspace.json", "edit"],
      ["api/chant.config.ts", "edit"],
      ["api/api.component.ts", "new"],
    ]);
    const decl = JSON.parse(p.files[0]!.after);
    expect(decl.ci).toEqual({
      workflow: "trunk-curated",
      green: { branch: "main", phases: { check: ["lint", "test"], suites: ["e2e"] }, require: ["check", "suites"], preMerge: ["check"] },
    });
    expect(decl.security).toBeUndefined();
    expect(p.files[1]!.after).toContain('environments: ["staging", "prod"],');
    expect(p.files[2]!.after).toContain("TODO(chant ci init)");
    expect(p.commands.map((c) => [c.cwd, c.args.join(" ")])).toEqual([
      ["api", "build --components --generate github --pr-loop --env staging"],
      [".", "ci workflow"],
      [".", "release workflow --forge github"],
    ]);
  });

  test("apply on merge passes --apply-on-merge, and --security adds the groups", () => {
    const root = fresh();
    const p = proposeCiInit(root, { workflow: "trunk-curated+apply-on-merge", security: ["supply-chain"] });
    expect(JSON.parse(p.files[0]!.after).security).toEqual(["supply-chain"]);
    expect(p.commands[0]!.args).toContain("--apply-on-merge");
  });

  test("a rerun after the writes and the generators proposes only what is still missing", async () => {
    const root = fresh();
    applyCiInit(root, proposeCiInit(root, { workflow: "trunk-curated" }));
    // What the generators would have written.
    writeFileSync(join(root, ".github/workflows/chant-pr.yml"), "jobs:\n  plan:\n    steps:\n      - run: chant ci run plan --env staging\n  record:\n    steps:\n      - run: chant ci run record --env staging\n");
    writeFileSync(join(root, ".github/workflows/chant-ci-green.yml"), "jobs:\n  tick:\n    steps:\n      - run: npx chant ci tick\n");
    writeFileSync(join(root, ".github/workflows/chant-release.yml"), renderReleaseWorkflow({ forge: "github", groups: new Set() }));
    const again = proposeCiInit(root, { workflow: "trunk-curated" });
    expect(again.files).toEqual([]);
    expect(again.commands).toEqual([]);
    // The stub keeps WSP151 asking.
    const report = await runDeclarationChecks(root, (f) => f, { gather: false });
    expect(report.diagnostics.filter((d) => d.ruleId === "WSP151").map((d) => d.code)).toEqual(["ci-workflow-no-components"]);
  });

  test("a component someone wrote is never edited; a missing gate is a note", () => {
    const root = fresh();
    writeFileSync(join(root, "api/api.component.ts"), 'export const api = { name: "api", deploy: [] };\n');
    const p = proposeCiInit(root, { workflow: "trunk-curated" });
    expect(p.files.map((f) => f.path)).not.toContain("api/api.component.ts");
    expect(p.notes.some((n) => n.startsWith("api/api.component.ts: add a gate()"))).toBe(true);
  });

  test("a JSONC declaration is refused, since its comments would be lost", () => {
    const root = repo({ "chant.workspace.jsonc": `// ours\n${DECLARATION}` });
    expect(() => proposeCiInit(root, { workflow: "trunk-curated" })).toThrow(/JSONC/);
  });

  test("a file that appeared after the proposal is never overwritten", () => {
    const root = fresh();
    const p = proposeCiInit(root, { workflow: "trunk-curated" });
    writeFileSync(join(root, "api/api.component.ts"), "// mine\n");
    expect(() => applyCiInit(root, p)).toThrow(/appeared after the proposal/);
    expect(readFileSync(join(root, "chant.workspace.json"), "utf-8")).toBe(DECLARATION);
  });
});

describe("the pieces", () => {
  test("inferGreen falls back to one check phase with no workflows", () => {
    expect(inferGreen(repo({}))).toEqual({ branch: "main", phases: { check: ["check"] }, require: ["check"], preMerge: ["check"] });
  });

  test("withEnvironments adds the order after export default {, and leaves anything else alone", () => {
    expect(withEnvironments("export default {\n  lexicons: [],\n};\n")).toBe('export default {\n  environments: ["staging", "prod"],\n  lexicons: [],\n};\n');
    expect(withEnvironments("export default defineConfig({});\n")).toBeNull();
  });

  test("the stub names a gate and the last environment", () => {
    expect(componentStub("api", "prod")).toMatch(/gate\("release", \{ description: "Approve the release for prod\." \}\)/);
  });

  test("editDeclarationText adds a missing key as text, and rewrites a changed one", () => {
    const text = '{\n  "name": "a",\n  "members": [{ "name": "x" }]\n}\n';
    const raw = JSON.parse(text);
    expect(editDeclarationText(text, raw, { ...raw, ci: { workflow: "trunk-curated" } })).toBe('{\n  "name": "a",\n  "members": [{ "name": "x" }],\n  "ci": {\n    "workflow": "trunk-curated"\n  }\n}\n');
    expect(editDeclarationText(text, raw, { ...raw, name: "b" })).toBe(`${JSON.stringify({ ...raw, name: "b" }, null, 2)}\n`);
    expect(editDeclarationText(text, raw, { ...raw })).toBe(text);
  });

  test("lineDiff marks added and removed lines", () => {
    expect(lineDiff("f", "a\nb\nc\n", "a\nx\nc\n")).toBe("--- a/f\n+++ b/f\n  a\n- b\n+ x\n  c");
    expect(lineDiff("g", null, "new\n")).toBe("--- /dev/null\n+++ b/g\n+ new");
  });
});

describe("release workflow", () => {
  test("no group: publish with --yes only, and no verify step", () => {
    const text = renderReleaseWorkflow({ forge: "github", groups: new Set() });
    expect(text).toContain('run: npx chant release publish "${GITHUB_REF_NAME#release/}" --yes');
    expect(text).not.toContain("release verify");
    expect(text).toContain("id-token: write");
  });

  test("supply-chain requires provenance, verified-releases verifies first", () => {
    const text = renderReleaseWorkflow({ forge: "github", groups: new Set(["supply-chain", "verified-releases"]) });
    expect(text).toContain("--require-provenance --yes");
    expect(text.indexOf("release verify")).toBeLessThan(text.indexOf("chant release publish \""));
    expect(publishFlags(new Set())).toEqual(["--yes"]);
  });

  test("gitlab writes a job with an ID token, and a nested workspace root cds into it", () => {
    const text = renderReleaseWorkflow({ forge: "gitlab", groups: new Set(), workspaceRoot: "infra", build: null });
    expect(text).toContain("SIGSTORE_ID_TOKEN");
    expect(text).toContain("    - cd infra");
    expect(text).not.toContain("npm run build");
  });
});
