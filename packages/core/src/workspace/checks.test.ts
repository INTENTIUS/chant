import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../cli/main";
import { runDeclarationChecks, WORKSPACE_CHECKS, workspaceCheckRules } from "./checks";
import { runWorkspaceCheck } from "./lineage-check";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-wsp-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const declaration = (members: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "acme", schema: 1, members, ...extra }, null, 2);

const kindsPackage = (dir: string, kinds: unknown[]) => ({
  [`${dir}/package.json`]: JSON.stringify({ name: dir.split("/").pop(), version: "1.0.0", exports: { "./workspace-kinds": "./k.json" } }),
  [`${dir}/k.json`]: JSON.stringify({ schema: 1, kinds }),
});
const tf = { name: "terraform", description: "a Terraform root module, with a main.tf", precedence: 400, probe: { anyFile: ["main.tf"] } };

const ids = (root: string) => runDeclarationChecks(root).diagnostics.map((d) => `${d.ruleId}:${d.entity ?? ""}`);

describe("the WSP catalog", () => {
  test("ids are WSP and three digits, unique and in order", () => {
    const list = WORKSPACE_CHECKS.map((c) => c.id);
    expect(list.every((id) => /^WSP\d{3}$/.test(id))).toBe(true);
    expect([...list].sort()).toEqual(list);
    expect(new Set(list).size).toBe(list.length);
  });

  test("the checks D3 says always fail are fixed", () => {
    const fixed = WORKSPACE_CHECKS.filter((c) => !c.configurable).map((c) => c.name);
    expect(fixed).toEqual(["declaration-unreadable", "kinds-unreadable", "kind-unknown", "kind-probe-tie", "other-claimed", "check-settings-invalid"]);
  });

  test("each check is also a rule for the SARIF reporter's metadata", () => {
    expect(workspaceCheckRules().map((r) => r.id)).toEqual(WORKSPACE_CHECKS.map((c) => c.id));
  });
});

describe("declaration checks (#2535)", () => {
  test("a clean workspace has no finding", () => {
    const root = repo({
      "chant.workspace.json": declaration([
        { name: "root", dir: ".", kind: "chant" },
        { name: "api", dir: "api", kind: "chant" },
        { name: "examples", kind: "examples", glob: "examples/*" },
      ]),
      "chant.config.ts": "",
      "api/chant.config.ts": "",
      "examples/one/chant.config.ts": "",
    });
    expect(runDeclarationChecks(root)).toEqual({ file: "chant.workspace.json", diagnostics: [], suppressed: [], ok: true });
  });

  test("an unknown kind fails closed and lists the known kinds", () => {
    const root = repo({ "chant.workspace.json": declaration([{ name: "infra", dir: "infra", kind: "terraform" }]), "infra/main.tf": "" });
    const report = runDeclarationChecks(root);
    expect(report.ok).toBe(false);
    expect(report.diagnostics).toEqual([
      {
        file: "chant.workspace.json",
        line: 8,
        column: 15,
        ruleId: "WSP003",
        severity: "error",
        message: "member infra has kind terraform, which no built-in kind or pinned package supplies; known kinds: chant, other, workspace",
        entity: "infra",
      },
    ]);
  });

  test("a pinned package supplies a kind, read as data", () => {
    const root = repo({
      "chant.workspace.json": declaration([{ name: "infra", dir: "infra", kind: "terraform" }], { pins: [{ path: "plugins/tf" }] }),
      ...kindsPackage("plugins/tf", [tf]),
      "infra/main.tf": "",
    });
    expect(ids(root)).toEqual([]);
  });

  test("a pin whose kinds can't be read is WSP002, and its kinds are unknown", () => {
    const root = repo({
      "chant.workspace.json": declaration([{ name: "infra", dir: "infra", kind: "terraform" }], { pins: [{ package: "tf-kinds", version: "1.0.0" }] }),
      "infra/main.tf": "",
    });
    // Ordered by where they sit in the file: the member comes before pins.
    expect(ids(root)).toEqual(["WSP003:infra", "WSP002:"]);
  });

  test("an other member needs because, is a warning, and fails when a registered probe claims it", () => {
    const root = repo({
      "chant.workspace.json": declaration([
        { name: "docs", dir: "docs", kind: "other", because: "an npm package" },
        { name: "legacy", dir: "legacy", kind: "other", because: "old scripts" },
      ]),
      "docs/package.json": "{}",
      "legacy/chant.config.ts": "",
    });
    const report = runDeclarationChecks(root);
    expect(report.diagnostics.map((d) => `${d.ruleId}:${d.entity}:${d.severity}`)).toEqual([
      "WSP009:docs:warning",
      "WSP009:legacy:warning",
      "WSP008:legacy:error",
    ]);
    expect(report.diagnostics[2].message).toMatch(/kind chant claims legacy: it is a chant project/);
    expect(report.ok).toBe(false);
  });

  test("a plugin kind's probe also claims an other directory", () => {
    const root = repo({
      "chant.workspace.json": declaration([{ name: "infra", dir: "infra", kind: "other", because: "not ours" }], { pins: [{ path: "plugins/tf" }] }),
      ...kindsPackage("plugins/tf", [tf]),
      "infra/main.tf": "",
    });
    expect(ids(root)).toEqual(["WSP009:infra", "WSP008:infra"]);
  });

  test("overlapping probes: the precedence decides, and a tie fails", () => {
    const tofu = { ...tf, name: "opentofu" };
    const root = repo({
      "chant.workspace.json": declaration(
        [
          { name: "infra", dir: "infra", kind: "terraform" },
          { name: "app", dir: "app", kind: "terraform" },
        ],
        { pins: [{ path: "plugins/tf" }, { path: "plugins/tofu" }] },
      ),
      ...kindsPackage("plugins/tf", [tf]),
      ...kindsPackage("plugins/tofu", [tofu]),
      "infra/main.tf": "",
      "app/main.tf": "",
      "app/chant.config.ts": "",
    });
    const report = runDeclarationChecks(root);
    const infra = report.diagnostics.find((d) => d.entity === "infra");
    const app = report.diagnostics.find((d) => d.entity === "app");
    expect(infra).toMatchObject({ ruleId: "WSP006", message: expect.stringMatching(/opentofu \(plugins\/tofu\) and terraform \(plugins\/tf\) all claim infra with precedence 400; a tie fails/) });
    // chant (500) outranks terraform (400): no tie, but the declared kind is not the one picked.
    expect(app).toMatchObject({ ruleId: "WSP007", message: expect.stringMatching(/declared terraform, and kind chant \(precedence 500\) claims app first/) });
  });

  test("the root member is not outranked by the workspace's own declaration", () => {
    const root = repo({ "chant.workspace.json": declaration([{ name: "root", dir: ".", kind: "chant" }]), "chant.config.ts": "" });
    expect(ids(root)).toEqual([]);
  });

  test("a missing directory, a failed probe and an empty group", () => {
    const root = repo({
      "chant.workspace.json": declaration([
        { name: "gone", dir: "gone", kind: "chant" },
        { name: "empty", dir: "empty", kind: "chant" },
        { name: "samples", kind: "examples", glob: "samples/*" },
      ]),
      "empty/README.md": "",
    });
    expect(ids(root)).toEqual(["WSP004:gone", "WSP005:empty", "WSP010:samples"]);
  });

  test("a declaration that can't be read is one WSP001 finding, with its location", () => {
    const root = repo({ "chant.workspace.json": declaration([{ name: "a", dir: "a", kind: "chant", dependsOn: [] }]) });
    const report = runDeclarationChecks(root);
    expect(report.ok).toBe(false);
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]).toMatchObject({ ruleId: "WSP001", line: 9, message: expect.stringMatching(/^declaration-invalid: unknown field "dependsOn"/) });
  });
});

describe("severity and suppression from the declaration", () => {
  const other = { name: "docs", dir: "docs", kind: "other", because: "an npm package" };

  test("checks sets a configurable check's severity, or turns it off", () => {
    const files = { "docs/x": "", "samples/.keep": "" };
    const group = { name: "samples", kind: "examples", glob: "samples/*" };
    const error = runDeclarationChecks(repo({ ...files, "chant.workspace.json": declaration([other, group], { checks: { WSP009: "error" } }) }));
    expect(error.diagnostics.map((d) => `${d.ruleId}:${d.severity}`)).toEqual(["WSP009:error", "WSP010:warning"]);
    expect(error.ok).toBe(false);
    const off = runDeclarationChecks(repo({ ...files, "chant.workspace.json": declaration([other, group], { checks: { WSP009: "off", WSP010: "info" } }) }));
    expect(off.diagnostics.map((d) => `${d.ruleId}:${d.severity}`)).toEqual(["WSP010:info"]);
  });

  test("an entry's suppress moves the finding to suppressed, with its reason", () => {
    const root = repo({ "docs/x": "", "chant.workspace.json": declaration([{ ...other, suppress: [{ check: "WSP009", because: "decided in #2557" }] }]) });
    const report = runDeclarationChecks(root);
    expect(report.diagnostics).toEqual([]);
    expect(report.suppressed).toEqual([expect.objectContaining({ ruleId: "WSP009", entity: "docs", reason: "decided in #2557" })]);
    expect(report.ok).toBe(true);
  });

  test("a fixed check can't be turned down or suppressed, and an unknown id is refused", () => {
    const root = repo({
      "legacy/chant.config.ts": "",
      "chant.workspace.json": declaration(
        [{ name: "legacy", dir: "legacy", kind: "other", because: "old", suppress: [{ check: "WSP008", because: "please" }, { check: "WSP999", because: "typo" }] }],
        { checks: { WSP003: "off" } },
      ),
    });
    const report = runDeclarationChecks(root);
    expect(report.suppressed).toEqual([]);
    expect(report.diagnostics.map((d) => d.ruleId).sort()).toEqual(["WSP008", "WSP009", "WSP011", "WSP011", "WSP011"]);
    const settings = report.diagnostics.filter((d) => d.ruleId === "WSP011").map((d) => d.message);
    expect(settings).toEqual([
      "legacy suppresses WSP008, which is fixed: it can't be turned down or suppressed",
      expect.stringMatching(/^legacy suppresses WSP999, which is not a declaration check; known checks: WSP001, /),
      "checks sets WSP003, which is fixed: it can't be turned down or suppressed",
    ]);
  });

  test("the schema refuses a checks key that isn't a WSP id and a suppression without because", () => {
    expect(ids(repo({ "chant.workspace.json": declaration([], { checks: { lint: "off" } }) }))).toEqual(["WSP001:"]);
    expect(ids(repo({ "docs/x": "", "chant.workspace.json": declaration([{ ...other, suppress: [{ check: "WSP009" }] }]) }))).toEqual(["WSP001:"]);
  });
});

describe("chant workspace check with a declaration", () => {
  let out: string[];
  let err: string[];
  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  });
  afterEach(() => vi.restoreAllMocks());

  const run = (cwd: string, ...argv: string[]) => {
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    return runWorkspaceCheck({ args: parseArgs(["workspace", "check", ...argv]), plugins: [] } as never);
  };

  const files = {
    "chant.workspace.json": declaration([
      { name: "docs", dir: "docs", kind: "other", because: "an npm package", suppress: [{ check: "WSP009", because: "decided" }] },
      { name: "infra", dir: "infra", kind: "terraform" },
    ]),
    "docs/x": "",
    "infra/main.tf": "",
  };

  test("--json adds the declaration's report to the lock report, and the exit code covers both", async () => {
    const root = repo(files);
    mkdirSync(join(root, "sub"));
    expect(await run(join(root, "sub"), "--json")).toBe(1);
    const doc = JSON.parse(out.join("\n"));
    expect(doc).toMatchObject({ lock: null, ok: false, findings: [], declaration: { file: "../chant.workspace.json", ok: false } });
    expect(doc.declaration.diagnostics.map((d: { ruleId: string }) => d.ruleId)).toEqual(["WSP003"]);
    expect(doc.declaration.suppressed.map((d: { ruleId: string; reason: string }) => `${d.ruleId}:${d.reason}`)).toEqual(["WSP009:decided"]);
  });

  test("--format sarif goes through lint's reporter, with the suppression marked external", async () => {
    const root = repo(files);
    expect(await run(root, "--format", "sarif")).toBe(1);
    const sarif = JSON.parse(out.join("\n"));
    expect(sarif.version).toBe("2.1.0");
    const results = sarif.runs[0].results as { ruleId: string; level: string; suppressions?: { kind: string; justification: string }[] }[];
    expect(results.map((r) => `${r.ruleId}:${r.level}`)).toEqual(["WSP003:error", "WSP009:warning"]);
    expect(results[1].suppressions).toEqual([{ kind: "external", justification: "decided" }]);
    expect(sarif.runs[0].tool.driver.rules.map((r: { id: string }) => r.id)).toEqual(["WSP003", "WSP009"]);
  });

  test("--format json prints lint's JSON: the active diagnostics", async () => {
    const root = repo(files);
    expect(await run(root, "--format", "json")).toBe(1);
    expect(JSON.parse(out.join("\n")).map((d: { ruleId: string }) => d.ruleId)).toEqual(["WSP003"]);
  });

  test("stylish lists the findings and the suppressed ones", async () => {
    const root = repo(files);
    expect(await run(root)).toBe(1);
    const text = out.join("\n");
    expect(text).toMatch(/chant\.workspace\.json/);
    expect(text).toMatch(/WSP003/);
    expect(text).toMatch(/Suppressed/);
    expect(err.join("\n")).not.toMatch(/nothing to check/);
  });

  test("with no declaration the report is the lock report alone", async () => {
    const root = repo({ "README.md": "" });
    expect(await run(root, "--json")).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({ lock: null, ok: true, findings: [] });
  });

  test("an unknown --format is refused", async () => {
    expect(await run(repo({}), "--format", "xml")).toBe(1);
    expect(err.join("\n")).toMatch(/--format xml is not a check format/);
  });
});
