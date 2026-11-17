/** #5263: a release command refuses a chant.config it can't load, naming the fix. */
import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refuseUnreadableReleaseConfig, unreadableConfigFix } from "./release-config";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-5263-")));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function refuse(cwd: string): Promise<{ code: number | null; out: string }> {
  const lines: string[] = [];
  const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  try {
    return { code: await refuseUnreadableReleaseConfig(cwd), out: lines.join("\n") };
  } finally {
    err.mockRestore();
  }
}

describe("release-config-unreadable (#5263)", () => {
  test("a config that loads, or none, lets the command run", async () => {
    expect((await refuse(tree({ "chant.config.ts": "export default { release: { tag: 'v{version}' } };\n" }))).code).toBeNull();
    expect((await refuse(tree({ "chant.config.json": '{ "release": {} }\n' }))).code).toBeNull();
    expect((await refuse(tree({ "package.json": "{}\n" }))).code).toBeNull();
  });

  test("a config that throws on load is refused, with its path and error", async () => {
    const root = tree({ "chant.config.ts": 'throw new Error("boom at load");\n' });
    const r = await refuse(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain("release-config-unreadable");
    expect(r.out).toContain(join(root, "chant.config.ts"));
    expect(r.out).toContain("boom at load");
  });

  test("a chant.config.json that is not JSON is refused", async () => {
    const r = await refuse(tree({ "chant.config.json": "{ release: " }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("release-config-unreadable");
  });

  test("the workspace root's config is read too", async () => {
    const root = tree({
      ".git/HEAD": "ref: refs/heads/main\n",
      "chant.workspace.json": JSON.stringify({ name: "acme", schema: 1, members: [{ name: "app", kind: "chant", path: "app" }] }),
      "chant.config.json": "not json",
      "app/chant.config.json": '{ "release": {} }\n',
    });
    const r = await refuse(join(root, "app"));
    expect(r.code).toBe(1);
    expect(r.out).toContain(join(root, "chant.config.json"));
  });

  test("a missing tsx names the project install, npx beside tsx, and chant.config.json", () => {
    const fix = unreadableConfigFix("chant needs tsx to run TypeScript; install it with: npm i -D tsx", "0.124.104");
    expect(fix).toContain("npm i -D tsx");
    expect(fix).toContain("npx -p tsx -p @intentius/chant@0.124.104 chant release");
    expect(fix).toContain("chant.config.json");
    expect(unreadableConfigFix("boom", "1.0.0")).not.toContain("tsx");
  });
});
