/**
 * WSP151, what a member under ci.workflow still lacks (#4168 step 6), and the
 * reference page printed from CI_WORKFLOW_REQUIREMENTS.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { runDeclarationChecks } from "../checks";
import { ciWorkflowTable, CI_WORKFLOW_FINDING_CODES, workflowOf } from "../ci-workflow";
import { REASON_CODES } from "../reason-codes";

const DOCS = fileURLToPath(new URL("../../../../../docs/src/content/docs/", import.meta.url));

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-ci-workflow-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const member = (extra: Record<string, unknown> = {}) => ({ name: "app", dir: "app", kind: "other", because: "the app", ...extra });
const declaration = (extra: Record<string, unknown> = {}, members = [member()]) => JSON.stringify({ name: "acme", schema: 1, members, ...extra }, null, 2);
const green = (extra: Record<string, unknown> = {}) => ({ branch: "main", phases: { check: ["check"], suites: ["suites"] }, require: ["check", "suites"], preMerge: ["check"], ...extra });

const CONFIG = 'export default { lexicons: ["aws"], environments: ["staging", "prod"] };\n';
const COMPONENT = 'import { gate, phase } from "@intentius/chant/components/component";\nexport const app = { name: "app", deploy: [phase("Apply", [gate("prod")])] };\n';
const PIPELINE = [
  "on: [pull_request, push]",
  "jobs:",
  "  plan:",
  "    steps:",
  "      - run: chant ci run plan --in-place --no-push --env prod --gate pr-apply --forge github",
  "  record:",
  "    steps:",
  "      - run: chant ci run record --in-place --env prod --gate pr-apply --forge github",
  "",
].join("\n");
const TICK = "jobs:\n  tick:\n    steps:\n      - run: npx --yes @intentius/chant@0.124.33 ci tick\n";
const PUBLISH = "jobs:\n  publish:\n    steps:\n      - run: npx chant release publish \"$LABEL\"\n";

/** A member under trunk-curated with everything the workflow needs. */
const complete = (extra: Record<string, string> = {}) => ({
  "chant.workspace.json": declaration({ ci: { workflow: "trunk-curated", green: green() } }),
  "app/chant.config.ts": CONFIG,
  "app/app.component.ts": COMPONENT,
  ".github/workflows/chant-pr.yml": PIPELINE,
  ".github/workflows/chant-ci-green.yml": TICK,
  ".github/workflows/chant-release.yml": PUBLISH,
  ...extra,
});

/** The WSP151 findings as [code, entity]. */
const found = async (root: string) =>
  (await runDeclarationChecks(root, (f) => f, { gather: false })).diagnostics.filter((d) => d.ruleId === "WSP151").map((d) => [d.code, d.entity ?? null]);

describe("ci.workflow (WSP151)", () => {
  test("a declaration that names no workflow gets no finding", async () => {
    const root = repo({ "chant.workspace.json": declaration(), "app/chant.config.ts": "export default {};\n" });
    expect(await found(root)).toEqual([]);
  });

  test("a workspace with everything trunk-curated needs passes", async () => {
    expect(await found(repo(complete()))).toEqual([]);
  });

  test("an empty workspace under trunk-curated reports each missing piece", async () => {
    const root = repo({ "chant.workspace.json": declaration({ ci: { workflow: "trunk-curated" } }), "app/chant.config.ts": "export default {};\n" });
    expect(await found(root)).toEqual([
      ["ci-workflow-no-environments", "app"],
      ["ci-workflow-no-components", "app"],
      ["ci-workflow-green-undeclared", null],
      ["ci-workflow-pipeline-missing", null],
      ["ci-workflow-publish-missing", null],
    ]);
  });

  test("no preMerge phases, and a required phase that matches the apply job", async () => {
    const root = repo(complete({ "chant.workspace.json": declaration({ ci: { workflow: "trunk-curated", green: green({ phases: { check: ["check"], deploy: ["*apply"] }, require: ["check", "deploy"], preMerge: [] }) } }) }));
    expect(await found(root)).toEqual([
      ["ci-workflow-no-pre-merge", null],
      ["ci-workflow-apply-in-green", null],
    ]);
  });

  test("a component with no gate", async () => {
    const root = repo(complete({ "app/app.component.ts": 'export const app = { name: "app", deploy: [] };\n' }));
    expect(await found(root)).toEqual([["ci-workflow-ungated-env", "app"]]);
  });

  test("trunk-curated with an apply job on merge differs", async () => {
    const root = repo(complete({ ".github/workflows/chant-pr.yml": PIPELINE.replace("ci run record", "ci run apply") }));
    expect(await found(root)).toEqual([["ci-workflow-pipeline-differs", null]]);
  });

  test("trunk-curated+apply-on-merge with only a record job differs, and with an apply job passes", async () => {
    const decl = declaration({ ci: { workflow: "trunk-curated+apply-on-merge", green: green() } });
    expect(await found(repo(complete({ "chant.workspace.json": decl })))).toEqual([["ci-workflow-pipeline-differs", null]]);
    expect(await found(repo(complete({ "chant.workspace.json": decl, ".github/workflows/chant-pr.yml": PIPELINE.replace("ci run record", "ci run apply") })))).toEqual([]);
  });

  test("a member's own workflow wins, and a top-level workflow skips members that don't build with chant", async () => {
    const root = repo({
      ...complete(),
      "chant.workspace.json": declaration({ ci: { green: green() } }, [member({ ci: { workflow: "trunk-curated" } }), member({ name: "docs", dir: "docs" })]),
      "docs/README.md": "",
    });
    expect(await found(root)).toEqual([]);
    const top = repo({ ...complete(), "docs/README.md": "", "chant.workspace.json": declaration({ ci: { workflow: "trunk-curated", green: green() } }, [member(), member({ name: "docs", dir: "docs" })]) });
    expect(await found(top)).toEqual([]);
  });

  test("ci.green.preMerge must name declared phases", async () => {
    const root = repo({ "chant.workspace.json": declaration({ ci: { green: green({ preMerge: ["lint"] }) } }) });
    const report = await runDeclarationChecks(root, (f) => f, { gather: false });
    expect(report.diagnostics.find((d) => d.ruleId === "WSP001")?.message).toMatch(/ci\.green\.preMerge names the phase "lint"/);
  });
});

describe("workflowOf", () => {
  test("the member's own wins over the top level's", () => {
    const d = { ci: { green: null, workflow: "trunk-curated" as const, reportUrl: null } };
    expect(workflowOf(d, { ciWorkflow: null })).toBe("trunk-curated");
    expect(workflowOf(d, { ciWorkflow: "trunk-curated+apply-on-merge" })).toBe("trunk-curated+apply-on-merge");
    expect(workflowOf({ ci: null }, null)).toBeNull();
  });
});

describe("the ci.workflow codes and reference page", () => {
  test("every code is a read-contract reason code", () => {
    for (const code of CI_WORKFLOW_FINDING_CODES) expect(REASON_CODES, code).toContain(code);
  });

  test("the CI workflows page carries the table CI_WORKFLOW_REQUIREMENTS prints", () => {
    const page = readFileSync(join(DOCS, "reference", "ci-workflows.mdx"), "utf-8");
    const table = /^\| Code \| Requirement \|[^\n]*\n(?:\|[^\n]*\n)*/m.exec(page)?.[0].trimEnd();
    expect(table, "regenerate the table under Requirements from ciWorkflowTable()").toBe(ciWorkflowTable());
  });
});
