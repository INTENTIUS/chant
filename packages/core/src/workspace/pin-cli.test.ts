import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CommandContext } from "../cli/registry";
import { runWorkspacePin } from "./pin-cli";
import { integrityOf } from "./pin-integrity";

const cwd = process.cwd();
const scratch: string[] = [];
afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(integrity?: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-pin-cli-")));
  scratch.push(root);
  const files: Record<string, string> = {
    "plugins/tf/package.json": JSON.stringify({ name: "tf" }),
    "plugins/tf/k.json": "{}",
    "chant.workspace.json": JSON.stringify({ name: "w", schema: 1, pins: [{ path: "plugins/tf", ...(integrity ? { integrity } : {}) }], members: [{ name: "w", dir: ".", kind: "other", because: "test" }] }),
  };
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), t);
  }
  return root;
}

async function pin(root: string, path: string | undefined, json = false) {
  process.chdir(root);
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(s));
  vi.spyOn(console, "error").mockImplementation((s: string) => void err.push(s));
  const code = await runWorkspacePin({ args: { extraPositional: path, json } } as unknown as CommandContext);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("chant workspace pin (#2547)", () => {
  test("prints the integrity value, and says an unpinned path pin needs it", async () => {
    const root = workspace();
    const r = await pin(root, "plugins/tf");
    expect(r.code).toBe(0);
    expect(r.out).toBe(integrityOf(join(root, "plugins/tf")).integrity);
    expect(r.err).toContain('is a path pin with no integrity; add "integrity"');
  });

  test("--json names the path, the value, the file count and whether the declared pin matches", async () => {
    const root = workspace();
    const { integrity } = integrityOf(join(root, "plugins/tf"));
    const matching = workspace(integrity);
    const r = await pin(matching, "plugins/tf", true);
    expect(JSON.parse(r.out)).toEqual({ path: "plugins/tf", integrity: integrityOf(join(matching, "plugins/tf")).integrity, files: 2, pin: "matches" });
  });

  test("exits 1 when the declared pin no longer matches", async () => {
    const root = workspace("sha256-AAAA");
    const r = await pin(root, "plugins/tf");
    expect(r.code).toBe(1);
    expect(r.err).toContain("does not match the integrity its pin states (sha256-AAAA)");
  });

  test("refuses a path outside the workspace, and a missing argument", async () => {
    const root = workspace();
    expect((await pin(root, "../elsewhere")).code).toBe(1);
    expect((await pin(root, undefined)).code).toBe(1);
  });
});
