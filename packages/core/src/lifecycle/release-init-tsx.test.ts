/** #5235: without tsx, release init writes a config it can read back, or refuses before writing anything. */
import { describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandContext } from "../cli/registry";
import { runReleaseInit } from "../cli/handlers/release-init";

vi.mock("../ts-loader", async (importOriginal) => ({ ...(await importOriginal<typeof import("../ts-loader")>()), typeScriptLoaderAvailable: () => false }));

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-5235-")));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  expect(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root }).status).toBe(0);
  return root;
}

async function run(root: string, args: Record<string, unknown>): Promise<{ code: number; out: string }> {
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  try {
    return { code: await runReleaseInit({ args } as unknown as CommandContext), out: lines.join("\n") };
  } finally {
    cwd.mockRestore();
    log.mockRestore();
    err.mockRestore();
  }
}

describe("release init without tsx (#5235)", () => {
  test("a project with no config gets chant.config.json, and the workflow renders from it", async () => {
    const root = repo({ "package.json": JSON.stringify({ name: "acme" }), "package-lock.json": "{}" });
    const dry = await run(root, {});
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("release block for chant.config.json (a new file)");
    expect(dry.out).toContain("tsx, which chant needs to read a TypeScript config, is not installed here");

    const wrote = await run(root, { yes: true });
    expect(wrote.code, wrote.out).toBe(0);
    expect(existsSync(join(root, "chant.config.ts"))).toBe(false);
    const config = JSON.parse(readFileSync(join(root, "chant.config.json"), "utf-8")) as { release: { workflow: { trigger: string } } };
    expect(config.release.workflow.trigger).toBe("dispatch");
    expect(existsSync(join(root, ".github/workflows/chant-release.yml"))).toBe(true);
    expect(wrote.out).toContain("git add chant.config.json .github/workflows/chant-release.yml");
  });

  test("a project with a chant.config.ts is refused before anything is written", async () => {
    const before = "export default {};\n";
    const root = repo({ "package.json": JSON.stringify({ name: "acme" }), "chant.config.ts": before });
    const r = await run(root, { yes: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain("release-init-tsx-missing");
    expect(r.out).toContain("npm i -D tsx");
    expect(readFileSync(join(root, "chant.config.ts"), "utf-8")).toBe(before);
    expect(existsSync(join(root, ".github/workflows/chant-release.yml"))).toBe(false);
  });
});
