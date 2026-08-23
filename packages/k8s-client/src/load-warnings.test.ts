/**
 * Loading the client must not print Node's `[DEP0040] punycode deprecated`
 * warning (chant #1190). `@kubernetes/client-node` 1.x pulled `node-fetch@2`,
 * whose `whatwg-url` requires the deprecated `punycode` builtin, so the very
 * first `chant kube` command a newcomer ran started with a deprecation line.
 * 2.0.0 moved the HTTP layer to undici and dropped node-fetch.
 *
 * The check runs in a fresh child process: warnings are emitted once per
 * process, and vitest's own worker may already have loaded the module.
 */

import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

describe("loading @kubernetes/client-node (#1190)", () => {
  test("emits no punycode deprecation warning", () => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", 'await import("@kubernetes/client-node");'],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf-8" },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/DEP0040|punycode/);
  });
});
