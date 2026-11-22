/**
 * #5465: `chant release evidence` refuses what it can't act on before it
 * reads anything, and `--check` reads the directory named after it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../parse-args";
import { runReleaseEvidence } from "./release-evidence";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function run(argv: string[]): Promise<{ code: number; err: string; out: string }> {
  const err: string[] = [];
  const out: string[] = [];
  const e = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  const o = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  try {
    const code = await runReleaseEvidence({ args: parseArgs(argv), plugins: [], serializers: [] });
    return { code, err: err.join("\n"), out: out.join("\n") };
  } finally {
    e.mockRestore();
    o.mockRestore();
  }
}

describe("chant release evidence arguments", () => {
  test("parses the period, the output and the flags", () => {
    const a = parseArgs(["release", "evidence", "--since", "2026-10-01", "--until", "2026-11-01", "-o", "out", "--referrers", "--sigstore", "--assets", "dl", "--sign", "k"]);
    expect(a).toMatchObject({ path: "evidence", since: "2026-10-01", until: "2026-11-01", output: "out", referrers: true, sigstore: true, assets: "dl", sign: "k" });
    expect(parseArgs(["release", "evidence", "--check", "out"])).toMatchObject({ check: true, extraPositional: "out" });
  });

  test("needs a release or a period, not both, and -o", async () => {
    expect((await run(["release", "evidence", "-o", "x"])).err).toContain("needs a release, or a period with --since");
    expect((await run(["release", "evidence", "v1", "--since", "2026-01-01", "-o", "x"])).err).toContain("needs a release, or a period with --since");
    expect((await run(["release", "evidence", "v1"])).err).toContain("needs -o <dir>");
    expect((await run(["release", "evidence", "v1", "--until", "2026-01-01", "-o", "x"])).err).toContain("--until ends a period");
  });

  test("--check of a directory with no SHA256SUMS fails and says why", async () => {
    const d = mkdtempSync(join(tmpdir(), "chant-evidence-check-"));
    dirs.push(d);
    const r = await run(["release", "evidence", "--check", d, "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, problems: ["SHA256SUMS is missing, so nothing can be checked"] });
  });
});
