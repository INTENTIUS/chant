/**
 * #5109: a path a manifest names resolves against the checkout the audited
 * tree is in, and only when that checkout is the repository the manifest names.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { repoTreeOf, resolveRepoPath, sameRepository } from "./repo-path";

function checkout(origin?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-repo-path-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  mkdirSync(join(dir, "kubernetes/app"), { recursive: true });
  writeFileSync(join(dir, "kubernetes/app/cm.yaml"), "kind: ConfigMap\n");
  return dir;
}

describe("sameRepository", () => {
  test("ignores scheme, user, case and a .git suffix", () => {
    expect(sameRepository("git@github.com:Acme/Infra.git", "https://github.com/acme/infra")).toBe(true);
    expect(sameRepository("https://github.com/acme/infra.git", "ssh://git@github.com/acme/infra")).toBe(true);
  });
  test("a different host, a different path, or no path is another repository", () => {
    expect(sameRepository("https://github.com/acme/infra", "https://gitlab.com/acme/infra")).toBe(false);
    expect(sameRepository("https://github.com/acme/infra", "https://github.com/acme/other")).toBe(false);
    expect(sameRepository("https://github.com/acme/infra", "x")).toBe(false);
  });
});

describe("resolveRepoPath", () => {
  test("finds a directory from the checkout root when origin is the repository", () => {
    const dir = checkout("https://github.com/acme/infra.git");
    expect(resolveRepoPath(dir, "https://github.com/acme/infra", "kubernetes/app")).toEqual({ status: "found", path: "kubernetes/app" });
    expect(resolveRepoPath(dir, "https://github.com/acme/infra", "./kubernetes/../kubernetes/app/")).toEqual({ status: "found", path: "kubernetes/app" });
    expect(resolveRepoPath(dir, "https://github.com/acme/infra", "/kubernetes/app").status).toBe("found");
  });

  test("resolves from the checkout root when the audited directory is below it", () => {
    const dir = checkout("https://github.com/acme/infra.git");
    expect(resolveRepoPath(join(dir, "kubernetes"), "https://github.com/acme/infra", "kubernetes/app").status).toBe("found");
  });

  test("a missing path, a file, and a path out of the checkout are missing", () => {
    const dir = checkout("https://github.com/acme/infra.git");
    const url = "https://github.com/acme/infra";
    expect(resolveRepoPath(dir, url, "kubernetes/gone").status).toBe("missing");
    expect(resolveRepoPath(dir, url, "kubernetes/app/cm.yaml").status).toBe("missing");
    expect(resolveRepoPath(dir, url, "kubernetes/app/cm.yaml", { type: "file" }).status).toBe("found");
    expect(resolveRepoPath(dir, url, "../../etc").status).toBe("missing");
  });

  test("a repository the origin does not name is elsewhere, and says nothing about the path", () => {
    const dir = checkout("https://github.com/acme/infra.git");
    expect(resolveRepoPath(dir, "https://github.com/acme/other", "kubernetes/gone").status).toBe("elsewhere");
    expect(resolveRepoPath(dir, "x", "kubernetes/app").status).toBe("elsewhere");
  });

  test("a tree with no origin resolves against the directory, unless an origin is required", () => {
    const git = checkout();
    expect(repoTreeOf(git).origin).toBeUndefined();
    expect(resolveRepoPath(git, "https://github.com/acme/infra", "kubernetes/app").status).toBe("found");
    expect(resolveRepoPath(git, "https://github.com/acme/infra", "kubernetes/app", { requireOrigin: true }).status).toBe("elsewhere");

    const plain = mkdtempSync(join(tmpdir(), "chant-repo-path-plain-"));
    mkdirSync(join(plain, "kubernetes/app"), { recursive: true });
    expect(resolveRepoPath(plain, "https://github.com/acme/infra", "kubernetes/app").status).toBe("found");
    expect(resolveRepoPath(plain, "https://github.com/acme/infra", "kubernetes/gone").status).toBe("missing");
  });
});
