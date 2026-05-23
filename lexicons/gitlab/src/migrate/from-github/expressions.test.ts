import { describe, test, expect } from "vitest";
import { substituteExpressions, translateIfCondition, translateIfFunction } from "./expressions";

describe("substituteExpressions — context vars", () => {
  const ctx = { gitlabPath: "x", sourceKey: "y" };

  test.each([
    ["${{ github.sha }}", "$CI_COMMIT_SHA"],
    ["${{ github.ref }}", "$CI_COMMIT_REF_NAME"],
    ["${{ github.ref_name }}", "$CI_COMMIT_REF_NAME"],
    ["${{ github.repository }}", "$CI_PROJECT_PATH"],
    ["${{ github.repository_owner }}", "$CI_PROJECT_NAMESPACE"],
    ["${{ github.actor }}", "$GITLAB_USER_LOGIN"],
    ["${{ github.event_name }}", "$CI_PIPELINE_SOURCE"],
    ["${{ github.run_id }}", "$CI_PIPELINE_ID"],
    ["${{ github.run_number }}", "$CI_PIPELINE_IID"],
    ["${{ github.job }}", "$CI_JOB_NAME"],
    ["${{ github.head_ref }}", "$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME"],
    ["${{ github.base_ref }}", "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"],
    ["${{ github.workspace }}", "$CI_PROJECT_DIR"],
    ["${{ runner.workspace }}", "$CI_PROJECT_DIR"],
    ["${{ job.status }}", "$CI_JOB_STATUS"],
    ["${{ strategy.job-index }}", "$CI_NODE_INDEX"],
    ["${{ strategy.job-total }}", "$CI_NODE_TOTAL"],
  ])("%s → %s", (input, expected) => {
    expect(substituteExpressions(input, ctx).output).toBe(expected);
  });
});

describe("substituteExpressions — user-defined vars", () => {
  const ctx = { gitlabPath: "x", sourceKey: "y" };

  test("env.NAME → $NAME", () => {
    expect(substituteExpressions("${{ env.NODE_VERSION }}", ctx).output).toBe("$NODE_VERSION");
  });

  test("vars.NAME → $NAME", () => {
    expect(substituteExpressions("${{ vars.REGISTRY }}", ctx).output).toBe("$REGISTRY");
  });

  test("secrets.NAME → $NAME", () => {
    expect(substituteExpressions("${{ secrets.API_TOKEN }}", ctx).output).toBe("$API_TOKEN");
  });

  test("inputs.NAME → $NAME", () => {
    expect(substituteExpressions("${{ inputs.environment }}", ctx).output).toBe("$environment");
  });

  test("matrix.NAME → $NAME", () => {
    expect(substituteExpressions("${{ matrix.os }}", ctx).output).toBe("$os");
  });

  test("multiple substitutions in one string", () => {
    expect(
      substituteExpressions("Deploying ${{ env.APP }} to ${{ vars.ENV }}", ctx).output,
    ).toBe("Deploying $APP to $ENV");
  });
});

describe("substituteExpressions — needs-review", () => {
  const ctx = { gitlabPath: "x", sourceKey: "y" };

  test("steps.<id>.outputs.<name> → $name + needs-review", () => {
    const { output, provenance } = substituteExpressions("${{ steps.get-version.outputs.tag }}", ctx);
    expect(output).toBe("$tag");
    expect(provenance.some((p) => p.category === "needs-review")).toBe(true);
  });

  test("needs.<job>.outputs.<name> → $name + needs-review", () => {
    const { output, provenance } = substituteExpressions("${{ needs.build.outputs.version }}", ctx);
    expect(output).toBe("$version");
    expect(provenance.some((p) => p.rule === "MIG-NEEDS-OUTPUTS-001")).toBe(true);
  });

  test("runner.os has no equivalent", () => {
    const { provenance } = substituteExpressions("${{ runner.os }}", ctx);
    expect(provenance.some((p) => p.rule === "MIG-EXPR-NO-EQUIV")).toBe(true);
  });

  test("github.run_attempt has no equivalent", () => {
    const { provenance } = substituteExpressions("${{ github.run_attempt }}", ctx);
    expect(provenance.some((p) => p.rule === "MIG-EXPR-NO-EQUIV")).toBe(true);
  });
});

describe("translateIfFunction", () => {
  test("always()", () => {
    expect(translateIfFunction("always()").whenClause).toBe("always");
  });
  test("success()", () => {
    expect(translateIfFunction("success()").whenClause).toBe("on_success");
  });
  test("failure()", () => {
    expect(translateIfFunction("failure()").whenClause).toBe("on_failure");
  });
  test("cancelled() flagged for review", () => {
    expect(translateIfFunction("cancelled()").needsReview).toBe(true);
  });
});

describe("translateIfCondition", () => {
  const ctx = { gitlabPath: "rules", sourceKey: "if" };

  test("simple branch comparison", () => {
    const { ifExpression } = translateIfCondition("github.ref == 'refs/heads/main'", ctx);
    expect(ifExpression).toContain("$CI_COMMIT_REF_NAME");
  });

  test("boolean function alone → when:", () => {
    const r = translateIfCondition("failure()", ctx);
    expect(r.whenClause).toBe("on_failure");
    expect(r.ifExpression).toBe("");
  });

  test("retains operators", () => {
    const { ifExpression } = translateIfCondition(
      "github.event_name == 'push' && github.ref == 'refs/heads/main'",
      ctx,
    );
    expect(ifExpression).toContain("$CI_PIPELINE_SOURCE");
    expect(ifExpression).toContain("$CI_COMMIT_REF_NAME");
    expect(ifExpression).toContain("&&");
  });
});
