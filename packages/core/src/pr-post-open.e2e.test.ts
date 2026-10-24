/**
 * `chant components pr-post --open` refusals (#4328), through the CLI handler.
 * Importing the handler loads the CLI's lexicon machinery, which runs past the
 * unit-test budget (#2817), so this lives in the e2e project.
 */

import { describe, expect, test, vi } from "vitest";
import type { CommandContext } from "./cli/registry";

describe("chant components pr-post --open refuses what it cannot post for (#4328)", () => {
  const run = async (args: Record<string, unknown>): Promise<number> => {
    const { runComponentsPrPost } = await import("./cli/handlers/pr");
    return runComponentsPrPost({ args } as unknown as CommandContext);
  };

  test("--pr or --head, a forge other than GitLab, and no branch are each refused", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
    try {
      expect(await run({ open: true, pr: 7, env: "prod", forge: "gitlab" })).toBe(1);
      expect(await run({ open: true, env: "prod", forge: "github" })).toBe(1);
      const branch = process.env.CI_COMMIT_BRANCH;
      delete process.env.CI_COMMIT_BRANCH;
      try {
        expect(await run({ open: true, env: "prod", forge: "gitlab" })).toBe(1);
      } finally {
        if (branch !== undefined) process.env.CI_COMMIT_BRANCH = branch;
      }
    } finally {
      spy.mockRestore();
    }
    expect(errors.join("\n")).toMatch(/takes no --pr or --head/);
    expect(errors.join("\n")).toMatch(/--forge gitlab/);
    expect(errors.join("\n")).toMatch(/pass --branch <branch>/);
  });
});
