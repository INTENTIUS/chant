import { describe, test, expect } from "vitest";
import { applyCommand, rollbackCommand, defaultOutput, applyEndpoint } from "./apply";

describe("applyCommand (#124)", () => {
  test("kubectl never → plain apply, no prune", () => {
    const cmd = applyCommand("kubectl", "prod", "dist", "never");
    expect(cmd).toContain("kubectl apply -f dist");
    expect(cmd).not.toContain("--prune");
  });

  test("kubectl owned-only → prune scoped to the chant ownership marker", () => {
    const cmd = applyCommand("kubectl", "prod", "dist", "owned-only");
    expect(cmd).toContain("--prune");
    expect(cmd).toContain("--selector app.kubernetes.io/managed-by=chant");
  });

  test("kubectl gated → same owned-scoped prune as owned-only", () => {
    expect(applyCommand("kubectl", "prod", "dist", "gated")).toBe(
      applyCommand("kubectl", "prod", "dist", "owned-only"),
    );
  });

  test("cloudformation deploys to the env stack", () => {
    const cmd = applyCommand("cloudformation", "prod", "stack.json", "owned-only");
    expect(cmd).toContain("aws cloudformation deploy");
    expect(cmd).toContain("--stack-name prod");
    expect(cmd).toContain("--template-file stack.json");
  });

  test("arm uses Complete mode only when deleting", () => {
    expect(applyCommand("arm", "rg", "t.json", "owned-only")).toContain("--mode Complete");
    expect(applyCommand("arm", "rg", "t.json", "never")).toContain("--mode Incremental");
  });
});

describe("applyEndpoint (#926)", () => {
  const url = "http://localhost:4566";

  test("injects --endpoint-url into the cloudformation deploy when an endpoint is set", () => {
    const cmd = applyEndpoint(applyCommand("cloudformation", "prod", "template.json", "never"), "cloudformation", url);
    expect(cmd).toBe(
      `aws --endpoint-url '${url}' cloudformation deploy --template-file template.json --stack-name prod --capabilities CAPABILITY_NAMED_IAM`,
    );
  });

  test("passes through with no endpoint, or for non-cloudformation targets", () => {
    const cfn = applyCommand("cloudformation", "prod", "template.json", "never");
    expect(applyEndpoint(cfn, "cloudformation", undefined)).toBe(cfn);
    expect(applyEndpoint(cfn, "cloudformation", "")).toBe(cfn);
    const k = applyCommand("kubectl", "prod", "dist", "never");
    expect(applyEndpoint(k, "kubectl", url)).toBe(k);
    const arm = applyCommand("arm", "rg", "t.json", "never");
    expect(applyEndpoint(arm, "arm", url)).toBe(arm);
  });

  test("never deletes a foreign resource: prune is always marker-scoped", () => {
    // The only delete path is the marker-scoped prune/complete — there is no
    // unscoped delete command, so a foreign (unmarked) resource is never pruned.
    const cmd = applyCommand("kubectl", "prod", "dist", "owned-only");
    expect(cmd).toContain("managed-by=chant");
  });
});

describe("rollbackCommand (#125)", () => {
  test("cloudformation has a native rollback", () => {
    expect(rollbackCommand("cloudformation", "prod")).toBe(
      "aws cloudformation rollback-stack --stack-name prod",
    );
  });

  test("kubectl / arm have no native single-command rollback", () => {
    expect(rollbackCommand("kubectl", "prod")).toBeUndefined();
    expect(rollbackCommand("arm", "rg")).toBeUndefined();
  });
});

describe('defaultOutput (target-aware apply output)', () => {
  test('kubectl → dist (dir); cloudformation/arm → template.json (file)', () => {
    expect(defaultOutput('kubectl')).toBe('dist');
    expect(defaultOutput('cloudformation')).toBe('template.json');
    expect(defaultOutput('arm')).toBe('template.json');
  });
});
