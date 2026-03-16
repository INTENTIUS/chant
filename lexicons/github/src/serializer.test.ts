import { describe, test, expect } from "bun:test";
import { githubSerializer } from "./serializer";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";

// ── Mock entities ──────────────────────────────────────────────────

class MockWorkflow implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "github";
  readonly entityType = "GitHub::Actions::Workflow";
  readonly kind = "resource" as const;
  readonly props: Record<string, unknown>;

  constructor(props: Record<string, unknown> = {}) {
    this.props = props;
  }
}

class MockJob implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "github";
  readonly entityType = "GitHub::Actions::Job";
  readonly kind = "resource" as const;
  readonly props: Record<string, unknown>;

  constructor(props: Record<string, unknown> = {}) {
    this.props = props;
  }
}

class MockStep implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "github";
  readonly entityType = "GitHub::Actions::Step";
  readonly kind = "property" as const;
  readonly props: Record<string, unknown>;

  constructor(props: Record<string, unknown> = {}) {
    this.props = props;
  }
}

class MockPushTrigger implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "github";
  readonly entityType = "GitHub::Actions::PushTrigger";
  readonly kind = "resource" as const;
  readonly props: Record<string, unknown>;

  constructor(props: Record<string, unknown> = {}) {
    this.props = props;
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe("githubSerializer", () => {
  test("has correct name", () => {
    expect(githubSerializer.name).toBe("github");
  });

  test("has correct rulePrefix", () => {
    expect(githubSerializer.rulePrefix).toBe("GHA");
  });
});

describe("githubSerializer.serialize", () => {
  test("serializes empty entities", () => {
    const entities = new Map<string, Declarable>();
    const output = githubSerializer.serialize(entities);
    expect(output).toBe("\n");
  });

  test("serializes a workflow with name", () => {
    const entities = new Map<string, Declarable>();
    entities.set("workflow", new MockWorkflow({
      name: "CI",
      on: { push: { branches: ["main"] } },
    }));

    const output = githubSerializer.serialize(entities) as string;
    expect(output).toContain("name: CI");
    expect(output).toContain("on:");
    expect(output).toContain("push:");
  });

  test("serializes jobs with kebab-case names", () => {
    const entities = new Map<string, Declarable>();
    entities.set("workflow", new MockWorkflow({
      name: "CI",
      on: { push: { branches: ["main"] } },
    }));
    entities.set("buildAndTest", new MockJob({
      "runs-on": "ubuntu-latest",
      steps: [{ name: "Test", run: "npm test" }],
    }));

    const output = githubSerializer.serialize(entities) as string;
    expect(output).toContain("build-and-test:");
    expect(output).toContain("runs-on: ubuntu-latest");
  });

  test("serializes triggers from workflow on: property", () => {
    const entities = new Map<string, Declarable>();
    entities.set("workflow", new MockWorkflow({
      name: "CI",
      on: {
        push: { branches: ["main"] },
        pullRequest: { branches: ["main"] },
      },
    }));

    const output = githubSerializer.serialize(entities) as string;
    expect(output).toContain("on:");
    expect(output).toContain("push:");
    expect(output).toContain("pull_request:");
  });

  test("serializes permissions", () => {
    const entities = new Map<string, Declarable>();
    entities.set("workflow", new MockWorkflow({
      name: "CI",
      on: { push: null },
      permissions: { contents: "read", pullRequests: "write" },
    }));

    const output = githubSerializer.serialize(entities) as string;
    expect(output).toContain("permissions:");
    expect(output).toContain("contents: read");
    expect(output).toContain("pull-requests: write");
  });

  test("serializes multiple jobs", () => {
    const entities = new Map<string, Declarable>();
    entities.set("workflow", new MockWorkflow({
      name: "CI",
      on: { push: { branches: ["main"] } },
    }));
    entities.set("build", new MockJob({ "runs-on": "ubuntu-latest" }));
    entities.set("test", new MockJob({ "runs-on": "ubuntu-latest" }));
    entities.set("deploy", new MockJob({ "runs-on": "ubuntu-latest" }));

    const output = githubSerializer.serialize(entities) as string;
    expect(output).toContain("jobs:");
    expect(output).toContain("build:");
    expect(output).toContain("test:");
    expect(output).toContain("deploy:");
  });

  test("omits undefined/null values", () => {
    const entities = new Map<string, Declarable>();
    entities.set("workflow", new MockWorkflow({
      name: "CI",
      on: { push: { branches: ["main"] } },
    }));
    entities.set("job", new MockJob({
      "runs-on": "ubuntu-latest",
      timeoutMinutes: undefined,
    }));

    const output = githubSerializer.serialize(entities) as string;
    expect(output).not.toContain("timeout-minutes:");
  });

  test("converts camelCase job props to kebab-case", () => {
    const entities = new Map<string, Declarable>();
    entities.set("workflow", new MockWorkflow({
      name: "CI",
      on: { push: null },
    }));
    entities.set("job", new MockJob({
      "runs-on": "ubuntu-latest",
      timeoutMinutes: 30,
      continueOnError: true,
    }));

    const output = githubSerializer.serialize(entities) as string;
    expect(output).toContain("timeout-minutes: 30");
    expect(output).toContain("continue-on-error: true");
  });

  test("serializes trigger entities", () => {
    const entities = new Map<string, Declarable>();
    entities.set("workflow", new MockWorkflow({
      name: "CI",
    }));
    entities.set("push", new MockPushTrigger({
      branches: ["main", "develop"],
    }));

    const output = githubSerializer.serialize(entities) as string;
    expect(output).toContain("on:");
    expect(output).toContain("push:");
    expect(output).toContain("- main");
    expect(output).toContain("- develop");
  });
});

describe("multi-workflow output", () => {
  test("produces SerializerResult with files", () => {
    const entities = new Map<string, Declarable>();
    entities.set("ci", new MockWorkflow({
      name: "CI",
      on: { push: { branches: ["main"] } },
    }));
    entities.set("deploy", new MockWorkflow({
      name: "Deploy",
      on: { push: { branches: ["main"] } },
    }));

    const output = githubSerializer.serialize(entities);
    expect(typeof output).toBe("object");
    const result = output as { primary: string; files: Record<string, string> };
    expect(result.files).toBeDefined();
    expect(Object.keys(result.files).length).toBe(2);
    expect(result.primary).toContain("name: CI");
  });
});

describe("expression serialization", () => {
  test("serializes intrinsic expressions to ${{ }} strings", () => {
    const mockExpr = {
      [INTRINSIC_MARKER]: true,
      toYAML: () => "${{ github.ref }}",
      toJSON: () => "${{ github.ref }}",
      toString: () => "${{ github.ref }}",
    };

    const entities = new Map<string, Declarable>();
    entities.set("workflow", new MockWorkflow({
      name: "CI",
      on: { push: null },
    }));
    entities.set("job", new MockJob({
      "runs-on": "ubuntu-latest",
      if: mockExpr,
    }));

    const output = githubSerializer.serialize(entities) as string;
    expect(output).toContain("${{ github.ref }}");
  });
});

describe("YAML key ordering", () => {
  test("emits keys in canonical order", () => {
    const entities = new Map<string, Declarable>();
    entities.set("workflow", new MockWorkflow({
      name: "CI",
      on: { push: null },
      permissions: { contents: "read" },
      env: { NODE_ENV: "production" },
    }));
    entities.set("job", new MockJob({
      "runs-on": "ubuntu-latest",
    }));

    const output = githubSerializer.serialize(entities) as string;
    const nameIdx = output.indexOf("name:");
    const onIdx = output.indexOf("on:");
    const permIdx = output.indexOf("permissions:");
    const envIdx = output.indexOf("env:");
    const jobsIdx = output.indexOf("jobs:");

    expect(nameIdx).toBeLessThan(onIdx);
    expect(onIdx).toBeLessThan(permIdx);
    expect(permIdx).toBeLessThan(envIdx);
    expect(envIdx).toBeLessThan(jobsIdx);
  });
});
