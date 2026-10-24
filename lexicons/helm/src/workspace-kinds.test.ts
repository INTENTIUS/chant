/**
 * The helm-chart member kind this lexicon supplies to a chant workspace
 * (#3179): data in `workspace-kinds.json`, exported at `./workspace-kinds`.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeWorkspaceKindConformance } from "@intentius/chant-test-utils";
import { checkMemberFile, loadMemberFileSchema, readPackageKinds } from "../../../packages/core/src/workspace/kinds";

const packageDir = join(import.meta.dirname, "..");

/** What each kind's own file must do: pass for a good one, fail for a bad one (#3672). */
function memberFileChecks(kind: string, good: string, bad: string): void {
  describe(`${kind} member file`, () => {
    const memberFile = readPackageKinds(packageDir).kinds.find((k) => k.name === kind)!.memberFile!;
    it("names a schema that loads", () => {
      expect(loadMemberFileSchema(memberFile, packageDir)).toBeUndefined();
    });
    it("passes a valid file", () => {
      expect(checkMemberFile(memberFile, memberFile.path, good)).toEqual([]);
    });
    it("fails an invalid one", () => {
      expect(checkMemberFile(memberFile, memberFile.path, bad).length).toBeGreaterThan(0);
    });
  });
}

describeWorkspaceKindConformance({
  packageDir,
  scenarios: [
    { name: "a chart", kind: "helm-chart", files: { "Chart.yaml": "apiVersion: v2\nname: web\nversion: 0.1.0\n", "values.yaml": "" }, claims: true },
    { name: "a chart whose templates sit one level down", kind: "helm-chart", files: { "web/Chart.yaml": "apiVersion: v2\nname: web\nversion: 0.1.0\n" }, claims: false },
    { name: "values without a Chart.yaml", kind: "helm-chart", files: { "values.yaml": "a: 1\n" }, claims: false },
  ],
});

memberFileChecks("helm-chart", "apiVersion: v2\nname: web\nversion: 0.1.0\n", "apiVersion: v3\nname: web\n");
