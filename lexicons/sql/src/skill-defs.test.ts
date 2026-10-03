import { describe, expect, test } from "vitest";
import { sqlPlugin } from "./plugin";

describe("skills", () => {
  const skills = sqlPlugin.skills!();

  test("four skills, each with its file's content and a matching frontmatter name", () => {
    expect(skills.map((s) => s.name)).toEqual(["chant-sql", "chant-sql-plan", "chant-sql-rebuild", "chant-sql-postgres"]);
    for (const s of skills) {
      expect(s.content.length, s.name).toBeGreaterThan(500);
      expect(s.content).toContain(`skill: ${s.name}\n`);
    }
  });

  test("the rebuild skill declares the shipped Op", () => {
    const rebuild = skills.find((s) => s.name === "chant-sql-rebuild")!;
    expect(rebuild.content).toContain('import { ClickHouseRebuildOp } from "@intentius/chant-lexicon-sql/clickhouse"');
  });

  test("the Postgres skill cites only SQLPG ids that exist, and the ClickHouse skills none", async () => {
    const { rules } = await import("./lint/rules");
    const known = new Set<string>(rules.map((r) => r.id));
    const pg = skills.find((s) => s.name === "chant-sql-postgres")!;
    const ids = pg.content.match(/SQLPG\d{3}/g) ?? [];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(known.has(id), id).toBe(true);
    expect(pg.content).not.toMatch(/SQLCH\d{3}/);
    for (const s of skills.filter((s) => s.name !== "chant-sql-postgres")) expect(s.content, s.name).not.toMatch(/Postgres|SQLPG/);
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
