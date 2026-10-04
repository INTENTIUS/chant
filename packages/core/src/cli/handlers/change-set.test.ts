import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { composeChangeSet } from "../../change-set";
import { commandRegistry, parseArgs } from "../main";
import { resolveCommand } from "../registry";
import { runChangeSetSummary } from "./change-set";

const dir = mkdtempSync(join(tmpdir(), "chant-change-set-summary-"));
const file = join(dir, "change-set.json");
writeFileSync(
  file,
  JSON.stringify(
    composeChangeSet(
      ["a", "b"].map((m, i) => ({
        member: { member: m, lexicon: "terraform", planner: "terraform" as const, status: "planned" as const, planDigest: `jcs1-sha256:${String(i).padStart(64, "0")}`, holes: [] },
        entries: [{ member: m, lexicon: "terraform", planner: "terraform" as const, address: "aws_db_instance.main", type: "aws_db_instance", action: "delete" as const, attributes: [] }],
      })),
    ),
  ),
);

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(console, "log").mockImplementation((s) => void (out += String(s) + "\n"));
  vi.spyOn(console, "error").mockImplementation((s) => void (err += String(s) + "\n"));
  const args = parseArgs(argv);
  expect(resolveCommand(args, commandRegistry)?.def.name).toBe("change-set summary");
  const code = await runChangeSetSummary({ args, plugins: [], serializers: [] });
  return { code, out, err };
}

afterEach(() => vi.restoreAllMocks());

describe("chant change-set summary", () => {
  test("prints text, json and markdown, naming each destroy", async () => {
    const text = await run(["change-set", "summary", file]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("2 members: 1 group, 2 destroys or replacements.");
    expect(text.out).toContain("a: aws_db_instance.main (delete)");
    const json = await run(["change-set", "summary", file, "--format", "json"]);
    expect(JSON.parse(json.out).destroys).toHaveLength(2);
    const md = await run(["change-set", "summary", file, "--format", "markdown", "--limit", "500"]);
    expect(md.out).toContain("- `b: aws_db_instance.main (delete)`");
  });

  test("refuses a file that is not a change-set document, and an unknown format", async () => {
    const other = join(dir, "other.json");
    writeFileSync(other, "{}");
    expect((await run(["change-set", "summary", other])).err).toContain("is not a change-set document");
    expect((await run(["change-set", "summary", file, "--format", "html"])).code).toBe(1);
  });
});
