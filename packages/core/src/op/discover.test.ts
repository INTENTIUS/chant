import { describe, test, expect, vi, beforeEach } from "vitest";
import { discoverOps } from "./discover";

// Mock getRuntime to return git root pointing at the repo root
vi.mock("../runtime-adapter", () => ({
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
  test("discovers alb-deploy.op.ts from examples/", async () => {
    const { ops, errors } = await discoverOps();
    expect(errors).toHaveLength(0);
    expect(ops.has("alb-deploy")).toBe(true);
  });

  test("discovered Op has correct config shape", async () => {
    const { ops } = await discoverOps();
    const op = ops.get("alb-deploy");
    expect(op).toBeDefined();
    expect(op!.config.name).toBe("alb-deploy");
    expect(Array.isArray(op!.config.phases)).toBe(true);
    expect(op!.config.phases.length).toBeGreaterThan(0);
    expect(typeof op!.config.overview).toBe("string");
  });

  test("filePath points to the .op.ts source file", async () => {
    const { ops } = await discoverOps();
    const op = ops.get("alb-deploy");
    expect(op!.filePath).toMatch(/alb-deploy\.op\.ts$/);
  });
});
