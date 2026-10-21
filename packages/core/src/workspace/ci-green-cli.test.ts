/**
 * `chant ci tick` under the who-ran-it security group (#4168): no key, no tick.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { runCiTick } from "./ci-green-cli";
import { RUNNER_KEY_ENV } from "./ci-green";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function repo(extra: Record<string, unknown>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-ci-tick-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(
    join(root, "chant.workspace.json"),
    JSON.stringify({ name: "acme", schema: 1, members: [], ci: { green: { branch: "main", phases: { test: ["test"] }, require: ["test"], source: "runs" } }, ...extra }),
  );
  return root;
}

const ctx = (args: Record<string, unknown> = {}) => ({ args: { command: "ci", path: "tick", ...args }, plugins: [] }) as never;

describe("ci tick and who-ran-it", () => {
  test("under who-ran-it a tick with no runner key is refused before it reads anything", async () => {
    vi.stubEnv(RUNNER_KEY_ENV, "");
    vi.spyOn(process, "cwd").mockReturnValue(repo({ security: ["who-ran-it"] }));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...m: unknown[]) => void errors.push(m.map(String).join(" ")));
    expect(await runCiTick(ctx())).toBe(1);
    expect(errors.join("\n")).toContain("the workspace opts into who-ran-it, so the tick signs every tag it makes and needs a runner key");
  });

  test("without the group the same tick is not refused for its key", async () => {
    vi.stubEnv(RUNNER_KEY_ENV, "");
    vi.spyOn(process, "cwd").mockReturnValue(repo({}));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...m: unknown[]) => void errors.push(m.map(String).join(" ")));
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runCiTick(ctx());
    expect(errors.join("\n")).not.toContain("who-ran-it");
  });
});
