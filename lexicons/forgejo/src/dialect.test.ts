import { describe, test, expect } from "vitest";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { applyForgejoDialect, DEFAULT_RUNNER_LABELS } from "./dialect";

// ── Mock entities (github-tagged, as the dialect reuses github entities) ──

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

function entityMap(...pairs: Array<[string, Declarable]>): Map<string, Declarable> {
  return new Map(pairs);
}

describe("applyForgejoDialect — dropped keys", () => {
  test("drops workflow-level permissions and warns", () => {
    const wf = new MockWorkflow({ name: "CI", permissions: { contents: "read" } });
    const { entities, warnings } = applyForgejoDialect(entityMap(["workflow", wf]));
    const props = (entities.get("workflow") as MockWorkflow).props;
    expect(props.permissions).toBeUndefined();
    expect(props.name).toBe("CI");
    expect(warnings.filter((w) => w.includes("permissions"))).toHaveLength(1);
  });

  test("drops job and step continue-on-error, one warning each", () => {
    const job = new MockJob({
      "runs-on": "ubuntu-latest",
      "continue-on-error": true,
      steps: [
        { name: "a", run: "echo a", "continue-on-error": true },
        { name: "b", run: "echo b" },
      ],
    });
    const { entities, warnings } = applyForgejoDialect(entityMap(["build", job]));
    const props = (entities.get("build") as MockJob).props;
    expect(props["continue-on-error"]).toBeUndefined();
    const steps = props.steps as Array<Record<string, unknown>>;
    expect(steps[0]["continue-on-error"]).toBeUndefined();
    expect(steps[0].name).toBe("a");
    expect(warnings.filter((w) => w.includes("continue-on-error"))).toHaveLength(2);
  });

  test("also catches the camelCase spelling (continueOnError)", () => {
    const job = new MockJob({ continueOnError: true, "runs-on": "ubuntu-latest" });
    const { entities, warnings } = applyForgejoDialect(entityMap(["build", job]));
    const props = (entities.get("build") as MockJob).props;
    expect(props.continueOnError).toBeUndefined();
    expect(warnings.filter((w) => w.includes("continue-on-error"))).toHaveLength(1);
  });

  test("does not mutate the original entity", () => {
    const wf = new MockWorkflow({ name: "CI", permissions: { contents: "read" } });
    applyForgejoDialect(entityMap(["workflow", wf]));
    expect(wf.props.permissions).toEqual({ contents: "read" });
  });
});

describe("applyForgejoDialect — runner labels", () => {
  test("maps ubuntu-latest to the default Forgejo label", () => {
    const job = new MockJob({ "runs-on": "ubuntu-latest" });
    const { entities, warnings } = applyForgejoDialect(entityMap(["build", job]));
    expect((entities.get("build") as MockJob).props["runs-on"]).toBe(DEFAULT_RUNNER_LABELS["ubuntu-latest"]);
    expect(warnings).toHaveLength(0);
  });

  test("a project override changes the emitted label", () => {
    const job = new MockJob({ "runs-on": "ubuntu-latest" });
    const { entities } = applyForgejoDialect(entityMap(["build", job]), {
      runnerLabels: { "ubuntu-latest": "big-runner" },
    });
    expect((entities.get("build") as MockJob).props["runs-on"]).toBe("big-runner");
  });

  test("an unmapped label passes through with a warning", () => {
    const job = new MockJob({ "runs-on": "macos-latest" });
    const { entities, warnings } = applyForgejoDialect(entityMap(["build", job]));
    expect((entities.get("build") as MockJob).props["runs-on"]).toBe("macos-latest");
    expect(warnings.filter((w) => w.includes("macos-latest"))).toHaveLength(1);
  });

  test("remaps every label in an array form", () => {
    const job = new MockJob({ "runs-on": ["ubuntu-latest", "self-hosted"] });
    const { entities, warnings } = applyForgejoDialect(entityMap(["build", job]));
    expect((entities.get("build") as MockJob).props["runs-on"]).toEqual(["docker", "self-hosted"]);
    expect(warnings.filter((w) => w.includes("self-hosted"))).toHaveLength(1);
  });
});
