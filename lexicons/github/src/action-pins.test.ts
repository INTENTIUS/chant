import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { Workflow, Job } from "./generated/index";
import { Checkout } from "./composites/checkout";
import { SetupNode } from "./composites/setup-node";
import { githubSerializer } from "./serializer";
import { ACTION_PINS, actionRef } from "./action-pins";
import { gha021 } from "./lint/post-synth/gha021";
import { gha029 } from "./lint/post-synth/gha029";
import { gha059 } from "./lint/post-synth/gha059";

// #2510: the composites emit a current major by default, `pin: "sha"` emits
// the pinned commit, and the pinning checks agree with both.

function workflowYaml(pin?: "tag" | "sha"): string {
  const entities = new Map<string, unknown>([
    ["ci", new Workflow({ name: "CI", on: { push: {} } })],
    [
      "test",
      new Job({
        "runs-on": "ubuntu-latest",
        steps: [Checkout({ pin }).step, SetupNode({ nodeVersion: "22.x", cache: "npm", pin }).step],
      }),
    ],
  ]);
  return githubSerializer.serialize(entities as never) as string;
}

function ctx(yaml: string): PostSynthContext {
  return {
    outputs: new Map([["github", yaml]]),
    entities: new Map(),
    buildResult: { outputs: new Map([["github", yaml]]), entities: new Map(), warnings: [], errors: [], sourceFileCount: 1 },
  };
}

const pinningFindings = (yaml: string) =>
  [gha021, gha029, gha059].flatMap((check) => check.check(ctx(yaml)));

describe("action pins (#2510)", () => {
  test("every pin is a 40-character commit SHA on the major the composites emit", () => {
    for (const pin of Object.values(ACTION_PINS)) {
      expect(pin.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(pin.version.startsWith(`${pin.major}.`)).toBe(true);
    }
  });

  test("Checkout and SetupNode default to the current major, not v4", () => {
    expect(Checkout({}).step.props.uses).toBe("actions/checkout@v7");
    expect(SetupNode({}).step.props.uses).toBe("actions/setup-node@v7");
  });

  test("pin: \"sha\" writes the SHA as the ref and the version as a YAML comment", () => {
    const yaml = workflowYaml("sha");
    expect(yaml).toContain(`uses: actions/checkout@${ACTION_PINS["actions/checkout"].sha} # v7.0.1\n`);
    expect(yaml).toContain(`uses: actions/setup-node@${ACTION_PINS["actions/setup-node"].sha} # v7.0.0\n`);
    expect(yaml).not.toMatch(/uses: '/);
  });

  test("a SHA-pinned workflow passes GHA021, GHA029 and GHA059", () => {
    expect(pinningFindings(workflowYaml("sha"))).toEqual([]);
  });

  test("the default tag warning names the exact fix", () => {
    const messages = pinningFindings(workflowYaml()).map((d) => d.message);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain(`\`uses: ${actionRef("actions/checkout", "sha")}\``);
    expect(messages[0]).toContain(`Checkout({ pin: "sha" })`);
    expect(messages[1]).toContain(`\`uses: ${actionRef("actions/setup-node", "sha")}\``);
    expect(messages[1]).toContain(`SetupNode({ pin: "sha" })`);
  });

  test("an action outside the pin table gets no fix hint", () => {
    const yaml = "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: acme/deploy@v1\n";
    const [finding] = gha029.check(ctx(yaml));
    expect(finding.message).toMatch(/security\.$/);
  });
});
