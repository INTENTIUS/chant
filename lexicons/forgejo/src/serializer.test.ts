import { describe, test, expect } from "vitest";
import { Workflow, Job, Step } from "@intentius/chant-lexicon-github";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { forgejoSerializer } from "./serializer";

function asResult(out: string | SerializerResult): SerializerResult {
  return typeof out === "string" ? { primary: out } : out;
}

describe("forgejoSerializer identity", () => {
  test("claims the github partition with a distinct rule prefix", () => {
    // name is "github" on purpose — it serializes github-lexicon entities.
    expect(forgejoSerializer.name).toBe("github");
    expect(forgejoSerializer.rulePrefix).toBe("WFJ");
  });
});

describe("forgejoSerializer — github-style source roundtrip", () => {
  function buildSource(): Map<string, Declarable> {
    const workflow = new Workflow({
      name: "CI",
      on: { push: { branches: ["main"] } },
      permissions: { contents: "read" },
    }) as unknown as Declarable;
    const build = new Job({
      "runs-on": "ubuntu-latest",
      "continue-on-error": true,
      steps: [
        new Step({ name: "Build", run: "npm run build", "continue-on-error": true }),
        new Step({ name: "Test", run: "npm test" }),
      ],
    }) as unknown as Declarable;
    return new Map<string, Declarable>([
      ["workflow", workflow],
      ["build", build],
    ]);
  }

  test("emits on/jobs/steps from reused github entities", () => {
    const { primary } = asResult(forgejoSerializer.serialize(buildSource()));
    expect(primary).toContain("on:");
    expect(primary).toContain("jobs:");
    expect(primary).toContain("push:");
    expect(primary).toContain("Build");
    expect(primary).toContain("npm run build");
  });

  test("drops permissions and continue-on-error, warning on each", () => {
    const result = asResult(forgejoSerializer.serialize(buildSource()));
    expect(result.primary).not.toContain("permissions");
    expect(result.primary).not.toContain("continue-on-error");
    // workflow permissions + job continue-on-error + step continue-on-error
    expect((result.warnings ?? []).filter((w) => w.includes("permissions"))).toHaveLength(1);
    expect((result.warnings ?? []).filter((w) => w.includes("continue-on-error"))).toHaveLength(2);
  });

  test("maps ubuntu-latest to the default Forgejo runner label", () => {
    const { primary } = asResult(forgejoSerializer.serialize(buildSource()));
    expect(primary).toContain("runs-on: docker");
    expect(primary).not.toContain("ubuntu-latest");
  });

  test("a chant.config forgejo.runnerLabels override changes the label", () => {
    const out = forgejoSerializer.serialize(buildSource(), undefined, {
      config: { forgejo: { runnerLabels: { "ubuntu-latest": "big-runner" } } },
    });
    expect(asResult(out).primary).toContain("runs-on: big-runner");
  });

  test("an unmapped label passes through with a warning", () => {
    const job = new Job({ "runs-on": "windows-latest", steps: [new Step({ run: "echo hi" })] }) as unknown as Declarable;
    const out = forgejoSerializer.serialize(new Map([["build", job]]));
    const result = asResult(out);
    expect(result.primary).toContain("runs-on: windows-latest");
    expect((result.warnings ?? []).filter((w) => w.includes("windows-latest"))).toHaveLength(1);
  });
});

describe("forgejoSerializer — multi-workflow output", () => {
  test("additional workflows become separate files", () => {
    const a = new Workflow({ name: "A", on: { push: {} } }) as unknown as Declarable;
    const b = new Workflow({ name: "B", on: { push: {} } }) as unknown as Declarable;
    const out = forgejoSerializer.serialize(
      new Map<string, Declarable>([
        ["ci", a],
        ["release", b],
      ]),
    );
    const result = asResult(out);
    expect(result.primary).toContain("name: A");
    expect(Object.keys(result.files ?? {})).toContain("release.yml");
  });
});
