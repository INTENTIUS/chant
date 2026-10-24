/**
 * The cloudformation and cdk member kinds this lexicon supplies to a chant
 * workspace (#3179): data in `workspace-kinds.json`, exported at
 * `./workspace-kinds`.
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

const template = "AWSTemplateFormatVersion: '2010-09-09'\nResources:\n  B:\n    Type: AWS::S3::Bucket\n";

describeWorkspaceKindConformance({
  packageDir,
  scenarios: [
    { name: "a YAML template", kind: "cloudformation", files: { "stack.yaml": template }, claims: true },
    { name: "a JSON template with only Resources", kind: "cloudformation", files: { "stack.json": '{"Resources": {}}' }, claims: true },
    { name: "a YAML template using short-form tags", kind: "cloudformation", files: { "stack.yml": template + "Outputs:\n  N:\n    Value: !Ref B\n    Export:\n      Name: !Sub \"${AWS::StackName}-n\"\n" }, claims: true },
    { name: "a template one level down", kind: "cloudformation", files: { "infra/stack.yaml": template }, claims: false },
    { name: "a Kubernetes manifest", kind: "cloudformation", files: { "deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\n" }, claims: false },
    { name: "a package.json", kind: "cloudformation", files: { "package.json": '{"name": "x"}' }, claims: false },
    { name: "a CDK app", kind: "cdk", files: { "cdk.json": '{"app": "npx ts-node bin/app.ts"}', "package.json": "{}" }, claims: true },
    { name: "a CDK app one level down", kind: "cdk", files: { "infra/cdk.json": "{}" }, claims: false },
    // cloudformation (320) outranks cdk (315) when both claim a directory.
    { name: "a CDK app with a template beside it", kind: "cloudformation", files: { "cdk.json": '{"app": "x"}', "stack.yaml": template }, claims: true },
  ],
});

memberFileChecks("cdk", '{"app": "npx ts-node bin/app.ts"}', '{"context": {}}');
