/**
 * chant #2540 — the lineage lock, through the real CLI.
 *
 * Level 0 first: plain `chant init` and `chant vendor` over a `vendor.json`
 * write no lock and load no workspace module (#2525 rules 2 and 5). Then the
 * other side: `init --from`, `init --template` and `vendor migrate` write
 * `.chant/workspace.lock.json`, and the lineage code loads only for them.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { REPO_ROOT, git, makeScratch, runChant, workspaceModules } from "./harness";

const TIMEOUT_MS = 120_000;
const LOCK = ".chant/workspace.lock.json";

function put(base: string, rel: string, content: string): void {
  mkdirSync(dirname(join(base, rel)), { recursive: true });
  writeFileSync(join(base, rel), content);
}

/** A git repo (the harness reads `git status` after each run) with a vendor.json. */
function vendorProject(label: string): string {
  const root = makeScratch(label);
  git(root, ["init", "-q", "-b", "main"]);
  put(root, "shared/web/index.ts", "export const v = 1;\n");
  put(
    root,
    "vendor.json",
    JSON.stringify({ vendored: [{ name: "web", source: { type: "local", path: "shared/web" }, target: "vendor/web", ref: "v1" }] }, null, 2),
  );
  return root;
}

describe("chant #2540 — level 0 writes no lock and loads no lineage code", () => {
  test(
    "plain chant init",
    async () => {
      const root = makeScratch("lineage-init");
      git(root, ["init", "-q", "-b", "main"]);
      const run = await runChant(root, ["init", "--lexicon", "github", "proj"], { recordModules: true });
      expect(run.exit, run.stderr).toBe(0);
      expect(run.stdout).not.toContain(LOCK);
      expect(existsSync(join(root, "proj", LOCK))).toBe(false);
      expect(workspaceModules(run.modules)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "chant vendor pull and check over vendor.json",
    async () => {
      const root = vendorProject("lineage-vendor");
      const pull = await runChant(root, ["vendor", "pull"], { recordModules: true });
      expect(pull.exit, pull.stderr).toBe(0);
      expect(pull.stdout).toMatch(/^ {2}web → vendor\/web \(1 file\(s\), sha256:[0-9a-f]{12}…\)\n$/);
      expect(pull.stderr).toContain("Vendored 1 artifact(s)");
      expect(JSON.parse(readFileSync(join(root, "vendor.json"), "utf-8")).vendored[0].checksum).toMatch(/^sha256:/);
      expect(workspaceModules(pull.modules)).toEqual([]);

      // Today's pull still replaces the target wholesale for a vendor.json project.
      put(root, "vendor/web/index.ts", "edited\n");
      const check = await runChant(root, ["vendor", "check"], { recordModules: true });
      expect(check.exit).toBe(0);
      expect(check.stdout).toBe("  web: DRIFTED (working copy differs from the pin)\n");
      expect(workspaceModules(check.modules)).toEqual([]);
      await runChant(root, ["vendor", "pull"]);
      expect(readFileSync(join(root, "vendor/web/index.ts"), "utf-8")).toBe("export const v = 1;\n");
      expect(existsSync(join(root, LOCK))).toBe(false);
    },
    TIMEOUT_MS,
  );
});

describe("chant #2540 — lineage commands write the lock", () => {
  test(
    "init --from copies a template repository at a ref",
    async () => {
      const root = makeScratch("lineage-from");
      const tpl = join(root, "tpl");
      mkdirSync(tpl);
      git(tpl, ["init", "-q", "-b", "main"]);
      put(tpl, "svc/src/main.ts", "export const a = 1;\n");
      git(tpl, ["add", "-A"]);
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "v1"], { cwd: tpl });
      git(tpl, ["tag", "v1"]);
      const work = join(root, "work");
      mkdirSync(work);
      git(work, ["init", "-q", "-b", "main"]);

      const run = await runChant(work, ["init", "--from", `${tpl}@v1#svc`, "proj"], { recordModules: true });
      expect(run.exit, run.stderr).toBe(0);
      expect(run.stdout).toContain(`Lineage: ${tpl}#svc at v1`);
      const lock = JSON.parse(readFileSync(join(work, "proj", LOCK), "utf-8"));
      expect(lock.scopes["."].address.commit).toBe(git(tpl, ["rev-parse", "v1"]).trim());
      expect(workspaceModules(run.modules).some((m) => m.endsWith("/workspace/lineage-init.ts"))).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "init --from works on the chant repo: an example project at HEAD, with its lineage (#2557)",
    async () => {
      const work = makeScratch("lineage-chant-repo");
      git(work, ["init", "-q", "-b", "main"]);
      const example = "examples/getting-started";
      const run = await runChant(work, ["init", "--from", `${REPO_ROOT}@HEAD#${example}`, "proj"]);
      expect(run.exit, run.stderr).toBe(0);
      const head = git(REPO_ROOT, ["rev-parse", "HEAD"]).trim();
      const lock = JSON.parse(readFileSync(join(work, "proj", LOCK), "utf-8"));
      const scope = lock.scopes["."];
      expect(scope.address.commit).toBe(head);
      expect(scope.address.tree).toBe(git(REPO_ROOT, ["rev-parse", `HEAD:${example}`]).trim());
      const tracked = git(REPO_ROOT, ["ls-tree", "-r", "--name-only", `HEAD:${example}`]).trim().split("\n").sort();
      expect(Object.keys(scope.files).sort()).toEqual(tracked);
    },
    TIMEOUT_MS,
  );

  test(
    "vendor migrate, then pull keeps a local edit and reports a manual step",
    async () => {
      const root = vendorProject("lineage-migrate");
      await runChant(root, ["vendor", "pull"]);
      const migrate = await runChant(root, ["vendor", "migrate"]);
      expect(migrate.exit, migrate.stderr).toBe(0);
      expect(existsSync(join(root, "vendor.json"))).toBe(false);
      expect(JSON.parse(readFileSync(join(root, LOCK), "utf-8")).scopes["vendor/web"].kind).toBe("vendor");

      put(root, "vendor/web/index.ts", "edited\n");
      put(root, "shared/web/index.ts", "export const v = 2;\n");
      const pull = await runChant(root, ["vendor", "pull"]);
      expect(pull.exit, pull.stderr).toBe(0);
      expect(pull.stdout).toContain("manual step: index.ts (changed-locally)");
      expect(readFileSync(join(root, "vendor/web/index.ts"), "utf-8")).toBe("edited\n");

      const view = await runChant(root, ["workspace", "lineage", "--json"]);
      expect(JSON.parse(view.stdout).scopes[0].manualSteps).toHaveLength(1);
      const resolve = await runChant(root, ["workspace", "lineage", "resolve", "vendor/web/index.ts"]);
      expect(resolve.exit, resolve.stderr).toBe(0);
      const check = await runChant(root, ["vendor", "check"]);
      expect(check.exit).toBe(0);
      expect(check.stdout).toBe("  web: ok, 1 file(s) edited locally\n");
    },
    TIMEOUT_MS,
  );
});
