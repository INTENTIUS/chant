/**
 * Consumer applications never live in this repo.
 *
 * The wardens are consumer applications of chant — the same category as
 * loomster or fountain-ops. They live in their own repos and publish (if
 * at all) from their own repos. They were internalized into this monorepo
 * twice and reverted twice; this test is the durable form of that ruling
 * (see CLAUDE.md, "Hard boundary"). If it fails, remove the
 * internalization. Do not remove the test.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("consumer applications stay out of the monorepo", () => {
  test("no wardens/ tree exists", () => {
    expect(existsSync(join(repoRoot, "wardens"))).toBe(false);
  });

  test("no warden package is a workspace member", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
      workspaces?: string[];
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const glob of pkg.workspaces ?? []) {
      expect(glob).not.toMatch(/warden/i);
    }
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(name).not.toMatch(/warden/i);
    }
  });

  test("the release and publish plumbing never touches a warden", () => {
    for (const file of ["justfile", "scripts/publish-packages.sh", "scripts/audit-trusted-publishers.sh"]) {
      const content = readFileSync(join(repoRoot, file), "utf-8");
      expect(content, `${file} references wardens`).not.toMatch(/wardens\//);
    }
  });
});
