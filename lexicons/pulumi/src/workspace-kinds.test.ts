/**
 * The pulumi member kind this lexicon supplies to a chant workspace (#3179,
 * moved here from the terraform lexicon by #4453). It is data in
 * `workspace-kinds.json` at the package root, exported at
 * `./workspace-kinds`; chant reads it without importing the lexicon. The
 * kind keeps its name, `pulumi`, which behold keys on.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeWorkspaceKindConformance } from "@intentius/chant-test-utils";
import { checkMemberFile, loadMemberFileSchema, readPackageKinds } from "../../../packages/core/src/workspace/kinds";

const packageDir = join(import.meta.dirname, "..");

describeWorkspaceKindConformance({
  packageDir,
  scenarios: [
    // The kind is a probe and a check of Pulumi.yaml.
    { name: "a Pulumi program", kind: "pulumi", files: { "Pulumi.yaml": "name: app\nruntime: nodejs\n", "index.ts": "" }, claims: true },
    { name: "a Pulumi program one level down", kind: "pulumi", files: { "infra/Pulumi.yaml": "name: app\nruntime: nodejs\n" }, claims: false },
    { name: "a stack file alone", kind: "pulumi", files: { "Pulumi.dev.yaml": "config: {}\n" }, claims: false },
  ],
});

describe("the pulumi kind", () => {
  const kinds = readPackageKinds(packageDir);
  it("is named pulumi and reads its members with this lexicon", () => {
    expect(kinds.problems ?? []).toEqual([]);
    const kind = kinds.kinds.find((k) => k.name === "pulumi")!;
    expect(kind.graph?.lexicon).toBe("pulumi");
    expect(kind.graph?.config).toEqual({ member: { dir: "{dir}", label: "{member}" } });
  });
});

describe("pulumi member file", () => {
  const memberFile = readPackageKinds(packageDir).kinds.find((k) => k.name === "pulumi")!.memberFile!;
  it("names a schema that loads", () => {
    expect(loadMemberFileSchema(memberFile, packageDir)).toBeUndefined();
  });
  it("passes a program with a runtime, named or in an object", () => {
    expect(checkMemberFile(memberFile, "Pulumi.yaml", "name: app\nruntime: nodejs\n")).toEqual([]);
    expect(checkMemberFile(memberFile, "Pulumi.yaml", "name: app\nruntime:\n  name: python\n")).toEqual([]);
  });
  it("fails one with no runtime", () => {
    expect(checkMemberFile(memberFile, "Pulumi.yaml", "name: app\n").length).toBeGreaterThan(0);
  });
});
