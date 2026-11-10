/**
 * What a change reaches (#4984), moved from terragucci's comment-apply.ts:
 * roots with the reads the product hands, Terragrunt units from their
 * plain dependency paths at both ends of the range, Atmos instances by
 * component, and synthesized roots.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { literalTerragruntDependencies, reachedInstances, reachedRoots, reachedSynthesized, reachedUnits, type ReachGit } from "./reach";

/** Git that answers the diff with `files` and each `show <ref>:<path>` from `shows`. */
const fakeGit = (files: string[] | null, shows: Record<string, string> = {}): ReachGit => (args) => {
  if (args[0] === "diff") return files === null ? { status: 128, stdout: "", stderr: "bad range" } : { status: 0, stdout: files.join("\n"), stderr: "" };
  if (args[0] === "show") {
    const text = shows[args[1]!.replace(/^[^:]*:/, "")];
    return text === undefined ? { status: 128, stdout: "", stderr: "no such path" } : { status: 0, stdout: text, stderr: "" };
  }
  return { status: 1, stdout: "", stderr: "unexpected" };
};

describe("reachedRoots", () => {
  const repo = mkdtempSync(join(tmpdir(), "chant-reach-"));
  for (const r of ["net", "app", "dns"]) {
    mkdirSync(join(repo, r), { recursive: true });
    writeFileSync(join(repo, r, "main.tf"), "");
  }
  const reads = new Map([["app", new Set(["net"])], ["dns", new Set(["app"])]]);

  test("a changed root, and every root that reads it, followed through", () => {
    expect(reachedRoots(repo, fakeGit(["net/main.tf"]), "a", "b", ["net", "app", "dns"], reads)).toEqual({ targets: ["app", "dns", "net"] });
    expect(reachedRoots(repo, fakeGit(["dns/main.tf"]), "a", "b", ["net", "app", "dns"], reads)).toEqual({ targets: ["dns"] });
  });

  test("every root when git cannot diff the range", () => {
    expect(reachedRoots(repo, fakeGit(null), "a", "b", ["net", "app"])).toEqual({ targets: ["app", "net"], every: "git could not list the files it changes" });
  });
});

describe("reachedUnits", () => {
  const hcl = (dep: string) => `dependency "up" {\n  config_path = "${dep}"\n}\n`;

  test("a changed unit and the units that name it, at either end of the range", () => {
    const git = fakeGit(["live/vpc/main.tf"], { "live/app/terragrunt.hcl": hcl("../vpc"), "live/vpc/terragrunt.hcl": "" });
    expect(reachedUnits(git, "a", "b", ["live/vpc", "live/app", "live/dns"])).toEqual({ targets: ["live/app", "live/vpc"] });
  });

  test("a file in no unit's directory reaches every unit, and Markdown reaches nothing", () => {
    expect(reachedUnits(fakeGit(["root.hcl"]), "a", "b", ["x", "y"])).toEqual({ targets: ["x", "y"], every: "it changes `root.hcl`, which is in no unit's directory" });
    expect(reachedUnits(fakeGit(["README.md"]), "a", "b", ["x", "y"])).toEqual({ targets: [] });
  });

  test("only plain dependency paths are read", () => {
    expect(literalTerragruntDependencies(`${'dependency "a" {\n  config_path = "../a"\n}\n'}dependencies {\n  paths = ["../b", "\${local.c}"]\n}\n# dependency "z" { config_path = "../z" }`)).toEqual(["../a", "../b"]);
  });
});

describe("reachedInstances and reachedSynthesized", () => {
  test("an instance by its component, the ones that read it, and a manifest that reaches every one", () => {
    const componentOf = new Map([["vpc-prod", "components/terraform/vpc"], ["app-prod", "components/terraform/app"]]);
    const reads = new Map([["app-prod", new Set(["vpc-prod"])]]);
    expect(reachedInstances(fakeGit(["components/terraform/vpc/main.tf"]), "a", "b", ["vpc-prod", "app-prod"], componentOf, reads)).toEqual({ targets: ["app-prod", "vpc-prod"] });
    expect(reachedInstances(fakeGit(["stacks/prod.yaml"]), "a", "b", ["vpc-prod", "app-prod"], componentOf).every).toBe("it changes `stacks/prod.yaml`, which can change any Atmos instance");
  });

  test("synthesized roots: any file but Markdown reaches every root", () => {
    expect(reachedSynthesized(fakeGit(["docs/a.md"]), "a", "b", ["s1", "s2"])).toEqual({ targets: [] });
    expect(reachedSynthesized(fakeGit(["main.ts"]), "a", "b", ["s2", "s1"])).toEqual({ targets: ["s1", "s2"], every: "it changes `main.ts`, and the synth command writes every root from the repo's files" });
  });
});
