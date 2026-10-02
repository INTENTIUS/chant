import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import {
  auditTerraformState,
  gitignoreCoversTerraformState,
  isTerraformStateFile,
  isTerraformStatePath,
  isTerraformWorkDir,
  nestedGitignoreCovering,
  type ScannableFile,
} from "./terraform-state";
import { collectCandidates, walkCandidates } from "./discover";
import { RULE_CATALOG, RULE_CATEGORY } from "./catalog";

const file = (path: string): ScannableFile => ({ path, content: "" });

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "chant-tf023-"));
}

describe("the TF023 path detectors", () => {
  test.each([
    "terraform.tfstate",
    "terraform.tfstate.backup",
    "infra/prod/terraform.tfstate",
    "infra/prod.tfstate",
    "infra/prod.tfstate.backup",
  ])("%s is state", (path) => {
    expect(isTerraformStateFile(path)).toBe(true);
    expect(isTerraformStatePath(path)).toBe(true);
  });

  test.each(["main.tf", "terraform.tfvars", "state.json", "docs/tfstate.md"])("%s is not", (path) => {
    expect(isTerraformStateFile(path)).toBe(false);
  });

  test("the working directory is matched as a path segment, at any depth", () => {
    expect(isTerraformWorkDir(".terraform")).toBe(true);
    expect(isTerraformWorkDir(".terraform/providers/registry.terraform.io/hashicorp/aws/5.0.0")).toBe(true);
    expect(isTerraformWorkDir("infra/prod/.terraform")).toBe(true);
    expect(isTerraformWorkDir("infra/terraform/main.tf")).toBe(false);
  });
});

describe("auditTerraformState", () => {
  test("reports a committed state file as an error, without reading it", () => {
    const findings = auditTerraformState([file("infra/prod/terraform.tfstate")]);
    expect(findings).toHaveLength(1);
    expect(findings[0].checkId).toBe("TF023");
    expect(findings[0].severity).toBe("error");
    expect(findings[0].lexicon).toBe("terraform");
    expect(findings[0].file).toBe("infra/prod/terraform.tfstate");
    expect(findings[0].message).toContain("secret store");
  });

  test("reports a backup state file too", () => {
    expect(auditTerraformState([file("terraform.tfstate.backup")])).toHaveLength(1);
  });

  test("reports a `.terraform` directory once, not once per file inside it", () => {
    const findings = auditTerraformState([
      file(".terraform"),
      file(".terraform/modules/modules.json"),
      file(".terraform/providers/registry.terraform.io/hashicorp/aws/5.0.0/terraform-provider-aws"),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(".terraform");
    expect(findings[0].entity).toBe(".terraform");
  });

  test("reports each root's own working directory separately", () => {
    const findings = auditTerraformState([file("infra/prod/.terraform"), file("infra/staging/.terraform")]);
    expect(findings.map((f) => f.file)).toEqual(["infra/prod/.terraform", "infra/staging/.terraform"]);
  });

  test("says nothing about a repository with neither", () => {
    expect(auditTerraformState([{ path: "main.tf", content: 'resource "null_resource" "a" {}' }])).toEqual([]);
  });

  test("is catalogued in core, as a merge-worthy security rule", () => {
    expect(RULE_CATALOG.TF023.tier).toBe("merge-worthy");
    expect(RULE_CATALOG.TF023.category).toBe("security");
    expect(RULE_CATEGORY.TF023).toBe("security");
    expect(RULE_CATALOG.TF023.authority?.[0].url).toContain("#gitignore");
  });
});

describe("gitignoreCoversTerraformState", () => {
  test.each([
    ["*.tfstate", "terraform.tfstate"],
    ["*.tfstate.*", "terraform.tfstate.backup"],
    [".terraform/", ".terraform"],
    [".terraform*", ".terraform"],
    ["/terraform.tfstate", "terraform.tfstate"],
    ["**/.terraform", "infra/prod/.terraform"],
    ["# comment\n\n*.tfstate\n", "infra/prod/terraform.tfstate"],
  ])("%s covers %s", (gitignore, path) => {
    expect(gitignoreCoversTerraformState(gitignore, path)).toBe(true);
  });

  test.each([
    ["node_modules/\ndist/", "terraform.tfstate"],
    ["*.tfvars", "terraform.tfstate"],
    ["!terraform.tfstate", "terraform.tfstate"],
  ])("%s does not cover %s", (gitignore, path) => {
    expect(gitignoreCoversTerraformState(gitignore, path)).toBe(false);
  });
});

describe("discovery hands TF023 its paths, and nothing else changes", () => {
  test("a state file becomes a candidate with no content, so nothing reads it", () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, "main.tf"), 'resource "null_resource" "a" {}\n');
    writeFileSync(join(dir, "terraform.tfstate"), JSON.stringify({ version: 4, resources: [] }));
    const candidates = collectCandidates(dir);
    const state = candidates.find((c) => c.path === "terraform.tfstate");
    expect(state).toBeDefined();
    expect(state!.content).toBe("");
    expect(auditTerraformState(candidates)).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the walk records `.terraform` without descending into it", () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, "main.tf"), 'resource "null_resource" "a" {}\n');
    mkdirSync(join(dir, ".terraform", "providers"), { recursive: true });
    writeFileSync(join(dir, ".terraform", "providers", "huge.json"), "{}");
    const candidates = collectCandidates(dir);
    expect(candidates.map((c) => c.path).sort()).toEqual([".terraform", "main.tf"]);
    expect(auditTerraformState(candidates)).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a gitignored state file is on disk, not in the repository, so it is dropped", () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, ".gitignore"), ".terraform/\n*.tfstate\n*.tfstate.*\n");
    writeFileSync(join(dir, "main.tf"), 'resource "null_resource" "a" {}\n');
    writeFileSync(join(dir, "terraform.tfstate"), "{}");
    mkdirSync(join(dir, ".terraform"), { recursive: true });
    expect(auditTerraformState(collectCandidates(dir))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("nestedGitignoreCovering (#2528)", () => {
  const reader = (bodies: Record<string, string>) => (dir: string) => bodies[dir];

  test("finds a .gitignore between the path and the root, matched relative to its own directory", () => {
    expect(nestedGitignoreCovering("infra/prod/terraform.tfstate", reader({ infra: "*.tfstate\n" }))).toBe("infra");
    expect(nestedGitignoreCovering("infra/.terraform", reader({ infra: ".terraform/\n" }))).toBe("infra");
  });

  test("prefers the nearest one, as git does", () => {
    const bodies = reader({ infra: "*.tfstate\n", "infra/prod": "*.tfstate\n" });
    expect(nestedGitignoreCovering("infra/prod/terraform.tfstate", bodies)).toBe("infra/prod");
  });

  test("never reads the root's own .gitignore, and ignores one that does not cover the path", () => {
    const bodies = reader({ "": "*.tfstate\n", infra: "*.log\n", other: "*.tfstate\n" });
    expect(nestedGitignoreCovering("infra/terraform.tfstate", bodies)).toBeUndefined();
    expect(nestedGitignoreCovering("terraform.tfstate", bodies)).toBeUndefined();
  });
});

describe("walkCandidates reports what the next release changes, and changes nothing now (#2528)", () => {
  function writeFiles(dir: string, n: number): void {
    mkdirSync(join(dir, "docs"), { recursive: true });
    for (let i = 0; i < n; i++) writeFileSync(join(dir, "docs", `${String(i).padStart(3, "0")}.md`), "x");
  }

  test("a walk that reaches its limit with files left says it was truncated, and keeps the same first files", () => {
    const dir = tmpRepo();
    writeFiles(dir, 5);
    writeFileSync(join(dir, "terraform.tfstate"), "{}");
    const cut = walkCandidates(dir, { maxFiles: 5 });
    expect(cut.truncated).toBe(true);
    expect(cut.maxFiles).toBe(5);
    // `docs/` sorts first, so the state file is the one left behind.
    expect(cut.files).toEqual([]);
    const whole = walkCandidates(dir);
    expect(whole.truncated).toBe(false);
    expect(whole.maxFiles).toBe(1000);
    expect(whole.files.map((f) => f.path)).toEqual(["terraform.tfstate"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a tree of exactly the limit, or one whose remainder is skipped, is not truncated", () => {
    const dir = tmpRepo();
    writeFiles(dir, 5);
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "index.js"), "");
    mkdirSync(join(dir, "empty"), { recursive: true });
    expect(walkCandidates(dir, { maxFiles: 5 }).truncated).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a state file a nested .gitignore ignores is not a candidate (#2528)", () => {
    const dir = tmpRepo();
    mkdirSync(join(dir, "infra", ".terraform"), { recursive: true });
    writeFileSync(join(dir, "infra", ".gitignore"), "*.tfstate\n.terraform/\n");
    writeFileSync(join(dir, "infra", "terraform.tfstate"), "{}");
    const walk = walkCandidates(dir);
    expect(walk.files.map((f) => f.path)).toEqual([]);
    expect(auditTerraformState(walk.files)).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("only the .gitignore files between the path and the root apply, not a sibling's", () => {
    const dir = tmpRepo();
    mkdirSync(join(dir, "a"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "*.tfstate.backup\n");
    writeFileSync(join(dir, "a", ".gitignore"), "*.tfstate.backup\n*.log\n");
    writeFileSync(join(dir, "a", "terraform.tfstate"), "{}");
    writeFileSync(join(dir, "a", "terraform.tfstate.backup"), "{}");
    // A sibling's .gitignore is not between `a/` and the root.
    writeFileSync(join(dir, "b", ".gitignore"), "*.tfstate\n");
    const walk = walkCandidates(dir);
    expect(walk.files.map((f) => f.path)).toEqual(["a/terraform.tfstate"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
