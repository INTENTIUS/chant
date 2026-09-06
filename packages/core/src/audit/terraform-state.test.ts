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
  type ScannableFile,
} from "./terraform-state";
import { collectCandidates } from "./discover";
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
