import { describe, test, expect } from "vitest";
import { Dependabot, DependabotConfig } from "./dependabot";
import { githubSerializer } from "../serializer";
import type { SerializerResult } from "@intentius/chant/serializer";

describe("Dependabot composite (#294)", () => {
  test("ships safe defaults: cooldown + external code execution denied", () => {
    const cfg = Dependabot({ ecosystems: [{ packageEcosystem: "npm" }, { packageEcosystem: "github-actions" }] });
    expect(cfg).toBeInstanceOf(DependabotConfig);
    expect(cfg.props.version).toBe(2);
    expect(cfg.props.updates).toHaveLength(2);
    for (const u of cfg.props.updates) {
      expect(u.cooldown?.defaultDays).toBe(7);
      expect(u.insecureExternalCodeExecution).toBe("deny");
      expect(u.directory).toBe("/");
      expect(u.schedule.interval).toBe("weekly");
    }
  });

  test("serializes to a .github/dependabot.yml file (kebab-case keys)", () => {
    const cfg = Dependabot({ ecosystems: [{ packageEcosystem: "npm" }] });
    const result = githubSerializer.serialize(new Map([["deps", cfg]])) as SerializerResult;
    expect(typeof result).toBe("object");
    const yaml = result.files?.["dependabot.yml"];
    expect(yaml).toBeDefined();
    expect(yaml).toContain("version: 2");
    expect(yaml).toContain("package-ecosystem: npm");
    expect(yaml).toContain("open-pull-requests-limit: 5");
    expect(yaml).toContain("insecure-external-code-execution: deny");
    expect(yaml).toContain("default-days: 7");
  });

  test("emits dependabot.yml alongside a workflow", () => {
    const cfg = Dependabot({ ecosystems: [{ packageEcosystem: "pip", interval: "daily" }] });
    const wf = {
      [Symbol.for("chant.declarable")]: true,
      lexicon: "github",
      entityType: "GitHub::Actions::Workflow",
      kind: "resource" as const,
      props: { name: "CI" },
    };
    const result = githubSerializer.serialize(
      new Map<string, never>([["ci", wf as never], ["deps", cfg as never]]),
    ) as SerializerResult;
    expect(result.primary).toContain("name: CI");
    expect(result.files?.["dependabot.yml"]).toContain("package-ecosystem: pip");
  });
});
