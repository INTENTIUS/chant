import { describe, test, expect, vi, beforeEach } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverOps } from "./discover";

/** The example project that holds `ops/alb-deploy.op.ts`. */
const ALB_INFRA = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../examples/gitlab-aws-alb-infra");

// Mock getRuntime to return git root pointing at the repo root. Partial, via
// `importOriginal`: the modules a discovered Op file pulls in reach the rest of
// this module (`moduleDir`, for the lint presets), and a wholesale replacement
// would make them fail to load rather than fail an assertion.
vi.mock("../runtime-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-adapter")>()),
  getRuntime: () => ({
    spawn: async (cmd: string[]) => {
      if (cmd[0] === "git" && cmd[1] === "rev-parse") {
        // Return the actual repo root so the test can find the example op file
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
        return { stdout: stdout.trim(), stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  }),
}));

describe("discoverOps", () => {
  test("discovers alb-deploy.op.ts from its own project", async () => {
    const { ops, errors } = await discoverOps({ cwd: ALB_INFRA });
    expect(errors).toHaveLength(0);
    expect(ops.has("alb-deploy")).toBe(true);
  });

  test("from the git root, a child project's Ops are not discovered (#2527)", async () => {
    const { ops } = await discoverOps();
    expect(ops.has("alb-deploy")).toBe(false);
  });

  test("discovered Op has correct config shape", async () => {
    const { ops } = await discoverOps({ cwd: ALB_INFRA });
    const op = ops.get("alb-deploy");
    expect(op).toBeDefined();
    expect(op!.config.name).toBe("alb-deploy");
    expect(Array.isArray(op!.config.phases)).toBe(true);
    expect(op!.config.phases.length).toBeGreaterThan(0);
    expect(typeof op!.config.overview).toBe("string");
  });

  test("filePath points to the .op.ts source file", async () => {
    const { ops } = await discoverOps({ cwd: ALB_INFRA });
    const op = ops.get("alb-deploy");
    expect(op!.filePath).toMatch(/alb-deploy\.op\.ts$/);
  });
});
