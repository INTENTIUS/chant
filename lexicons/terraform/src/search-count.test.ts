/**
 * `chant search --count-by` on Terraform roots (chant #4360), run through the
 * real handler: the roots are read by this lexicon's `buildRoots()`, joined to
 * discovery the way `chant graph` joins them, and grouped by core.
 *
 * The fixture is `src/__fixtures__/graph-roots/` (two roots, `app` calling a
 * local `cdn` module), copied to a temporary project with a `chant.config.ts`
 * naming both roots.
 */

import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runSearch } from "@intentius/chant/cli/handlers/search";
import type { CommandContext } from "@intentius/chant/cli/registry";
import { terraformPlugin } from "./plugin";

const TREE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "graph-roots");

let dir: string;
let cwd: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-search-count-"));
  cpSync(join(TREE, "app"), join(dir, "app"), { recursive: true });
  cpSync(join(TREE, "network"), join(dir, "network"), { recursive: true });
  writeFileSync(
    join(dir, "chant.config.ts"),
    `export default { lexicons: ["terraform"], terraform: { binary: "terraform", roots: { app: { dir: "./app" }, network: { dir: "./network" } } } };\n`,
  );
  cwd = process.cwd();
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

/** Run `chant search` and return its exit code and stdout lines. */
async function search(args: Partial<CommandContext["args"]>): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await runSearch({ args: { path: "", ...args }, plugins: [terraformPlugin], serializers: [] } as unknown as CommandContext);
    return { code, out };
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

/** The group lines of a grouped answer, as `[count, group]`. */
function groups(out: string[]): Array<[number, string]> {
  return out
    .map((l) => /^\s*(\d+)\s{2}(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [Number(m[1]), m[2]]);
}

/** The total printed on the `— N total` line. */
function total(out: string[]): number {
  const line = out.find((l) => /^— \d+ total/.test(l));
  return Number(/^— (\d+) total/.exec(line ?? "")?.[1]);
}

describe("chant search on a Terraform project", () => {
  it("sees the roots' blocks at all", async () => {
    const { code, out } = await search({ path: "kind:Terraform::Resource" });
    expect(code).toBe(0);
    expect(out).toContain("app/aws_instance.web  Terraform::Resource");
    expect(out).toContain("network/aws_vpc.main  Terraform::Resource");
  });
});

describe("--count-by on a Terraform project", () => {
  it("module comes from the address, root-module blocks are (root), qualified per root", async () => {
    const { code, out } = await search({ countBy: "module" });
    expect(code).toBe(0);
    const g = groups(out);
    expect(g).toContainEqual([2, "app/module.cdn"]);
    expect(g.find(([, name]) => name === "app/(root)")).toBeDefined();
    expect(g.find(([, name]) => name === "network/(root)")).toBeDefined();
    expect(g.reduce((s, [c]) => s + c, 0)).toBe(total(out));
  });

  it("kind groups Terraform resources by resource type", async () => {
    const { out } = await search({ path: "kind:Terraform::Resource", countBy: "kind" });
    const g = groups(out);
    expect(g.map(([, name]) => name)).toEqual(["aws_cloudfront_distribution", "aws_instance", "aws_s3_bucket", "aws_vpc"]);
    expect(total(out)).toBe(4);
  });

  it("combined with a query, counts only the matches", async () => {
    const all = await search({ countBy: "module" });
    const resources = await search({ path: "kind:Terraform::Resource", countBy: "module" });
    expect(total(resources.out)).toBe(4);
    expect(total(all.out)).toBeGreaterThan(4);
    expect(groups(resources.out)).toEqual([
      [2, "app/(root)"],
      [1, "app/module.cdn"],
      [1, "network/(root)"],
    ]);
  });

  it("an attribute most blocks lack is counted under (none), and the groups add up", async () => {
    const { out } = await search({ countBy: "attr:expansion" });
    const g = groups(out);
    expect(g).toContainEqual([1, "count"]);
    expect(g.find(([, name]) => name === "(none)")).toBeDefined();
    expect(g.reduce((s, [c]) => s + c, 0)).toBe(total(out));
  });

  it("refuses a grouping it cannot read", async () => {
    const { code } = await search({ countBy: "provider" });
    expect(code).toBe(1);
  });
});
