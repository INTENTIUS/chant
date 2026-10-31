/**
 * `chant lifecycle drift --stack <name>` hands the stack to each lexicon's
 * `readDrift`, which is how `chant workspace drift --stack` reaches a pulumi
 * member's reader project.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReadDriftOptions } from "../../drift-record";
import { parseArgs } from "../parse-args";
import type { CommandContext } from "../registry";
import { runLifecycleDrift } from "./lifecycle-drift";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function run(argv: string[], answer: (o: ReadDriftOptions) => unknown): Promise<{ seen: ReadDriftOptions[]; code: number; out: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-drift-"));
  dirs.push(dir);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void out.push(line));
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => (out.push(String(chunk)), true));
  const seen: ReadDriftOptions[] = [];
  const plugin = { name: "fake", readDrift: async (o: ReadDriftOptions) => (seen.push(o), answer(o)) };
  const code = await runLifecycleDrift({ args: parseArgs(argv), plugins: [plugin] } as unknown as CommandContext);
  return { seen, code, out };
}

describe("chant lifecycle drift --stack", () => {
  test("the lexicon's readDrift gets the stack", async () => {
    const { seen, code } = await run(["lifecycle", "drift", ".", "--member", "shop", "--stack", "prod-eu"], () => ({ lines: [] }));
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ member: "shop", stack: "prod-eu" });
  });

  test("without it the option is absent", async () => {
    const { seen } = await run(["lifecycle", "drift", ".", "--member", "shop"], () => ({ lines: [] }));
    expect(seen[0]).not.toHaveProperty("stack");
  });

  test("a refusal is the one stdout line, exit 1", async () => {
    const { code, out } = await run(["lifecycle", "drift", ".", "--member", "shop", "--stack", "x"], () => ({ refused: { code: "no-drift-read", message: "no export for stack x" } }));
    expect(code).toBe(1);
    expect(JSON.parse(out.join("")).refused).toEqual({ code: "no-drift-read", message: "fake: no export for stack x" });
  });
});
