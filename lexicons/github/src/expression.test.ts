import { describe, test, expect } from "vitest";
import {
  Expression,
  github, runner, secrets, matrix, steps, needs, inputs, vars, env,
  always, failure, success, cancelled,
  contains, startsWith, toJSON, fromJSON, format,
  branch, tag,
} from "./expression";

describe("Expression", () => {
  test("wraps raw expression in ${{ }}", () => {
    const expr = new Expression("github.ref");
    expect(expr.toString()).toBe("${{ github.ref }}");
  });

  test("raw() returns unwrapped expression", () => {
    const expr = new Expression("github.sha");
    expect(expr.raw()).toBe("github.sha");
  });

  test("toJSON() returns toString()", () => {
    const expr = new Expression("github.ref");
    expect(expr.toJSON()).toBe("${{ github.ref }}");
  });

  test("toYAML() returns toString()", () => {
    const expr = new Expression("github.ref");
    expect(expr.toYAML()).toBe("${{ github.ref }}");
  });

  test("and() combines expressions", () => {
    const a = new Expression("github.ref == 'refs/heads/main'");
    const b = new Expression("github.event_name == 'push'");
    expect(a.and(b).toString()).toBe("${{ github.ref == 'refs/heads/main' && github.event_name == 'push' }}");
  });

  test("or() combines expressions", () => {
    const a = new Expression("github.ref == 'refs/heads/main'");
    const b = new Expression("github.ref == 'refs/heads/develop'");
    expect(a.or(b).toString()).toBe("${{ github.ref == 'refs/heads/main' || github.ref == 'refs/heads/develop' }}");
  });

  test("not() negates expression", () => {
    const expr = new Expression("github.event.pull_request.draft");
    expect(expr.not().toString()).toBe("${{ !(github.event.pull_request.draft) }}");
  });

  test("eq() creates equality comparison", () => {
    expect(github.ref.eq("refs/heads/main").toString()).toBe("${{ github.ref == 'refs/heads/main' }}");
  });

  test("ne() creates inequality comparison", () => {
    expect(github.ref.ne("refs/heads/main").toString()).toBe("${{ github.ref != 'refs/heads/main' }}");
  });
});

describe("Context accessors", () => {
  test("github context properties", () => {
    expect(github.ref.toString()).toBe("${{ github.ref }}");
    expect(github.sha.toString()).toBe("${{ github.sha }}");
    expect(github.actor.toString()).toBe("${{ github.actor }}");
    expect(github.repository.toString()).toBe("${{ github.repository }}");
  });

  test("runner context properties", () => {
    expect(runner.os.toString()).toBe("${{ runner.os }}");
    expect(runner.arch.toString()).toBe("${{ runner.arch }}");
  });

  test("secrets accessor", () => {
    expect(secrets("DEPLOY_KEY").toString()).toBe("${{ secrets.DEPLOY_KEY }}");
  });

  test("matrix accessor", () => {
    expect(matrix("node-version").toString()).toBe("${{ matrix.node-version }}");
  });

  test("steps accessor", () => {
    expect(steps("build").outputs("result").toString()).toBe("${{ steps.build.outputs.result }}");
  });

  test("needs accessor", () => {
    expect(needs("build").outputs("artifact-path").toString()).toBe("${{ needs.build.outputs.artifact-path }}");
  });

  test("inputs accessor", () => {
    expect(inputs("environment").toString()).toBe("${{ inputs.environment }}");
  });

  test("vars accessor", () => {
    expect(vars("API_URL").toString()).toBe("${{ vars.API_URL }}");
  });

  test("env accessor", () => {
    expect(env("NODE_ENV").toString()).toBe("${{ env.NODE_ENV }}");
  });
});

describe("Condition helpers", () => {
  test("always()", () => {
    expect(always().toString()).toBe("${{ always() }}");
  });

  test("failure()", () => {
    expect(failure().toString()).toBe("${{ failure() }}");
  });

  test("success()", () => {
    expect(success().toString()).toBe("${{ success() }}");
  });

  test("cancelled()", () => {
    expect(cancelled().toString()).toBe("${{ cancelled() }}");
  });
});

describe("Function helpers", () => {
  test("contains()", () => {
    expect(contains(github.ref, "main").toString()).toBe("${{ contains(github.ref, 'main') }}");
  });

  test("startsWith()", () => {
    expect(startsWith(github.ref, "refs/tags/").toString()).toBe("${{ startsWith(github.ref, 'refs/tags/') }}");
  });

  test("toJSON()", () => {
    expect(toJSON(github.event).toString()).toBe("${{ toJSON(github.event) }}");
  });

  test("fromJSON()", () => {
    expect(fromJSON(steps("meta").outputs("matrix")).toString()).toBe("${{ fromJSON(steps.meta.outputs.matrix) }}");
  });

  test("format()", () => {
    expect(format("{0}-{1}", github.ref, github.sha).toString()).toBe("${{ format('{0}-{1}', github.ref, github.sha) }}");
  });
});

describe("Convenience helpers", () => {
  test("branch()", () => {
    expect(branch("main").toString()).toBe("${{ github.ref == 'refs/heads/main' }}");
  });

  test("tag()", () => {
    expect(tag("v").toString()).toBe("${{ startsWith(github.ref, 'refs/tags/v') }}");
  });
});
