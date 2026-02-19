import { describe, test, expect } from "bun:test";
import { gitlabSerializer } from "./serializer";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";

// ── Mock entities ──────────────────────────────────────────────────

class MockJob implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "gitlab";
  readonly entityType = "GitLab::CI::Job";
  readonly kind = "resource" as const;
  readonly props: Record<string, unknown>;

  constructor(props: Record<string, unknown> = {}) {
    this.props = props;
  }
}

class MockDefault implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "gitlab";
  readonly entityType = "GitLab::CI::Default";
  readonly kind = "resource" as const;
  readonly props: Record<string, unknown>;

  constructor(props: Record<string, unknown> = {}) {
    this.props = props;
  }
}

class MockWorkflow implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "gitlab";
  readonly entityType = "GitLab::CI::Workflow";
  readonly kind = "resource" as const;
  readonly props: Record<string, unknown>;

  constructor(props: Record<string, unknown> = {}) {
    this.props = props;
  }
}

class MockPropertyEntity implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "gitlab";
  readonly entityType: string;
  readonly kind = "property" as const;
  readonly props: Record<string, unknown>;

  constructor(entityType: string, props: Record<string, unknown> = {}) {
    this.entityType = entityType;
    this.props = props;
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe("gitlabSerializer", () => {
  test("has correct name", () => {
    expect(gitlabSerializer.name).toBe("gitlab");
  });

  test("has correct rulePrefix", () => {
    expect(gitlabSerializer.rulePrefix).toBe("WGL");
  });
});

describe("gitlabSerializer.serialize", () => {
  test("serializes empty entities", () => {
    const entities = new Map<string, Declarable>();
    const output = gitlabSerializer.serialize(entities);
    // Empty pipeline should produce minimal output
    expect(output).toBe("\n");
  });

  test("serializes a simple job", () => {
    const entities = new Map<string, Declarable>();
    entities.set("testJob", new MockJob({
      stage: "test",
      script: ["npm test"],
    }));

    const output = gitlabSerializer.serialize(entities);
    expect(output).toContain("stages:");
    expect(output).toContain("- test");
    expect(output).toContain("test-job:");
    expect(output).toContain("script:");
    expect(output).toContain("- npm test");
  });

  test("collects stages from all jobs", () => {
    const entities = new Map<string, Declarable>();
    entities.set("buildJob", new MockJob({ stage: "build", script: ["make"] }));
    entities.set("testJob", new MockJob({ stage: "test", script: ["npm test"] }));
    entities.set("deployJob", new MockJob({ stage: "deploy", script: ["deploy.sh"] }));

    const output = gitlabSerializer.serialize(entities);
    expect(output).toContain("stages:");
    expect(output).toContain("- build");
    expect(output).toContain("- test");
    expect(output).toContain("- deploy");
  });

  test("deduplicates stages", () => {
    const entities = new Map<string, Declarable>();
    entities.set("jobA", new MockJob({ stage: "build", script: ["build1"] }));
    entities.set("jobB", new MockJob({ stage: "build", script: ["build2"] }));

    const output = gitlabSerializer.serialize(entities);
    // "build" should appear only once in the stages list
    const stagesSection = output.split("\n\n")[0]; // stages is the first section
    const stagesMatch = stagesSection.match(/- build/g);
    expect(stagesMatch).toHaveLength(1);
  });

  test("converts camelCase job names to kebab-case", () => {
    const entities = new Map<string, Declarable>();
    entities.set("myTestJob", new MockJob({ script: ["test"] }));

    const output = gitlabSerializer.serialize(entities);
    expect(output).toContain("my-test-job:");
  });

  test("converts camelCase property keys to snake_case", () => {
    const entities = new Map<string, Declarable>();
    entities.set("job", new MockJob({
      beforeScript: ["echo hello"],
      afterScript: ["echo done"],
      expireIn: "1 week",
    }));

    const output = gitlabSerializer.serialize(entities);
    expect(output).toContain("before_script:");
    expect(output).toContain("after_script:");
    expect(output).toContain("expire_in:");
  });

  test("serializes default settings", () => {
    const entities = new Map<string, Declarable>();
    entities.set("defaults", new MockDefault({
      interruptible: true,
      timeout: "30 minutes",
    }));

    const output = gitlabSerializer.serialize(entities);
    expect(output).toContain("default:");
    expect(output).toContain("interruptible: true");
    // "30 minutes" starts with a digit, so it gets quoted
    expect(output).toContain("timeout: '30 minutes'");
  });

  test("serializes workflow", () => {
    const entities = new Map<string, Declarable>();
    entities.set("workflow", new MockWorkflow({
      name: "My Pipeline",
    }));

    const output = gitlabSerializer.serialize(entities);
    expect(output).toContain("workflow:");
    expect(output).toContain("name: My Pipeline");
  });

  test("skips property-kind declarables", () => {
    const entities = new Map<string, Declarable>();
    entities.set("myImage", new MockPropertyEntity("GitLab::CI::Image", { name: "node:20" }));

    const output = gitlabSerializer.serialize(entities);
    // Property entities are embedded inline, not serialized as top-level
    expect(output).toBe("\n");
  });

  test("omits properties not present in props", () => {
    const entities = new Map<string, Declarable>();
    // Only set script — image and cache are not in props at all
    entities.set("job", new MockJob({
      script: ["test"],
    }));

    const output = gitlabSerializer.serialize(entities);
    expect(output).not.toContain("image:");
    expect(output).not.toContain("cache:");
  });

  test("serializes multi-job pipeline with defaults and workflow", () => {
    const entities = new Map<string, Declarable>();
    entities.set("defaults", new MockDefault({
      image: "node:20",
    }));
    entities.set("workflow", new MockWorkflow({
      name: "CI Pipeline",
    }));
    entities.set("lint", new MockJob({ stage: "test", script: ["npm run lint"] }));
    entities.set("test", new MockJob({ stage: "test", script: ["npm test"] }));
    entities.set("deploy", new MockJob({ stage: "deploy", script: ["deploy.sh"] }));

    const output = gitlabSerializer.serialize(entities);
    expect(output).toContain("stages:");
    expect(output).toContain("default:");
    expect(output).toContain("workflow:");
    expect(output).toContain("lint:");
    expect(output).toContain("test:");
    expect(output).toContain("deploy:");
  });
});

describe("string quoting", () => {
  test("quotes strings starting with $", () => {
    const entities = new Map<string, Declarable>();
    entities.set("job", new MockJob({
      script: ["$CI_COMMIT_SHA"],
    }));

    const output = gitlabSerializer.serialize(entities);
    // String starting with $ should be quoted
    expect(output).toContain("'$CI_COMMIT_SHA'");
  });

  test("quotes strings starting with *", () => {
    const entities = new Map<string, Declarable>();
    entities.set("job", new MockJob({
      script: ["*glob"],
    }));

    const output = gitlabSerializer.serialize(entities);
    expect(output).toContain("'*glob'");
  });

  test("quotes strings containing :", () => {
    const entities = new Map<string, Declarable>();
    entities.set("job", new MockJob({
      script: ["key: value"],
    }));

    const output = gitlabSerializer.serialize(entities);
    expect(output).toContain("'key: value'");
  });

  test("quotes YAML boolean-like strings", () => {
    const entities = new Map<string, Declarable>();
    entities.set("job", new MockJob({
      variables: { FLAG: "true", OTHER: "false", MAYBE: "null" },
    }));

    const output = gitlabSerializer.serialize(entities);
    expect(output).toContain("'true'");
    expect(output).toContain("'false'");
    expect(output).toContain("'null'");
  });

  test("does not quote plain strings", () => {
    const entities = new Map<string, Declarable>();
    entities.set("job", new MockJob({
      stage: "test",
    }));

    const output = gitlabSerializer.serialize(entities);
    expect(output).toContain("stage: test");
  });
});

describe("nested objects and arrays", () => {
  test("serializes nested objects", () => {
    const entities = new Map<string, Declarable>();
    entities.set("job", new MockJob({
      variables: {
        NODE_ENV: "production",
        CI: "true",
      },
    }));

    const output = gitlabSerializer.serialize(entities);
    expect(output).toContain("variables:");
    expect(output).toContain("node_env: production");
  });

  test("serializes arrays of strings", () => {
    const entities = new Map<string, Declarable>();
    entities.set("job", new MockJob({
      script: ["npm ci", "npm test", "npm run build"],
    }));

    const output = gitlabSerializer.serialize(entities);
    expect(output).toContain("- npm ci");
    expect(output).toContain("- npm test");
    expect(output).toContain("- npm run build");
  });

  test("serializes boolean values", () => {
    const entities = new Map<string, Declarable>();
    entities.set("job", new MockJob({
      interruptible: true,
      allowFailure: false,
    }));

    const output = gitlabSerializer.serialize(entities);
    expect(output).toContain("interruptible: true");
    expect(output).toContain("allow_failure: false");
  });

  test("serializes numeric values", () => {
    const entities = new Map<string, Declarable>();
    entities.set("job", new MockJob({
      parallel: 5,
    }));

    const output = gitlabSerializer.serialize(entities);
    expect(output).toContain("parallel: 5");
  });
});
