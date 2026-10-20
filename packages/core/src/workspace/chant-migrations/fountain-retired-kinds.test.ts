import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rewriteFountainFile } from "./fountain-retired-kinds";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "../__fixtures__/studio-template-84c8b21.json"), "utf-8")) as { files: Record<string, string> };
const team = fixture.files["delivery/agents/team.ts"]!;

describe("fountain-retired-kinds (#3987)", () => {
  test("the studio template's team.ts loses its Teammates, Schedules and persistent sandbox, and keeps its Agents", () => {
    const r = rewriteFountainFile("delivery/agents/team.ts", team)!;
    expect(r.conflict).toBeUndefined();
    expect(r.text).toContain('import { Agent, Environment, Vault } from "@intentius/chant-lexicon-fountain";');
    expect(r.text).not.toMatch(/new (Teammate|Schedule)\(|sandbox_mode|nightlyMeta|Teammates below/);
    for (const agent of ["formalizer", "splitter", "builderSmall", "builderMedium", "builderLarge", "dispatcher"]) expect(r.text).toContain(`export const ${agent} = new Agent({`);
    expect(r.text.endsWith("});\n")).toBe(true);
    expect(r.notMoved.map((n) => n.what)).toEqual([
      'the Schedule nightly (cron "0 3 * * *") in delivery/agents/team.ts',
      'the Schedule factoryDispatch (cron "*/15 * * * *") in delivery/agents/team.ts',
    ]);
    expect(rewriteFountainFile("delivery/agents/team.ts", r.text)).toBeNull();
  });

  test("a removed declaration the file still uses is a conflict", () => {
    const text = `${team}\nexport const crew = [factory];\n`;
    expect(rewriteFountainFile("delivery/agents/team.ts", text)!.conflict).toMatch(/^factory is still used/);
  });

  test("a file with no retired kind plans nothing", () => {
    const text = 'import { Agent } from "@intentius/chant-lexicon-fountain";\nexport const a = new Agent({\n  name: "a",\n});\n';
    expect(rewriteFountainFile("agents.ts", text)).toBeNull();
  });
});
