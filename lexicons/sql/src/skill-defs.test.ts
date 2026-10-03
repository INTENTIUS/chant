import { describe, expect, test } from "vitest";
import { sqlPlugin } from "./plugin";

describe("skills", () => {
  const skills = sqlPlugin.skills!();

  test("three skills, each with its file's content and a matching frontmatter name", () => {
    expect(skills.map((s) => s.name)).toEqual(["chant-sql", "chant-sql-plan", "chant-sql-rebuild"]);
    for (const s of skills) {
      expect(s.content.length, s.name).toBeGreaterThan(500);
      expect(s.content).toContain(`skill: ${s.name}\n`);
    }
  });

  test("the rebuild skill declares the shipped Op", () => {
    const rebuild = skills.find((s) => s.name === "chant-sql-rebuild")!;
    expect(rebuild.content).toContain('import { ClickHouseRebuildOp } from "@intentius/chant-lexicon-sql/clickhouse"');
  });

  test("every SQLCH id a skill cites exists in the lexicon", async () => {
    const { rules } = await import("./lint/rules");
    const { postSynthChecks } = await import("./lint/post-synth");
    const known = new Set<string>([...rules.map((r) => r.id), ...postSynthChecks.map((c) => c.id)]);
    for (const s of skills) {
      // The SQLCH2xx ids are the classifier's, which come from the plan rules, not from a lint rule.
      for (const id of s.content.match(/SQLCH0\d\d|SQLCH1\d\d/g) ?? []) expect(known.has(id), `${s.name}: ${id}`).toBe(true);
    }
  });
});
