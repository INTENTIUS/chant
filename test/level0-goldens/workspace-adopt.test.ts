/**
 * chant #2551 — `chant workspace adopt-lineage`, `hash-index` and `versions`
 * through the real CLI: a project copied by hand from a template at a tag,
 * with no lock, adopts a lineage; the lineage reads as adopted; a published
 * hash index is accepted as a cache; and `versions` reports the family.
 *
 * The level-0 side is pinned by level0-goldens.test.ts, which asserts that no
 * level-0 command loads a module under `workspace/`. These commands are
 * workspace code, loaded only when they run.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { git, makeScratch, runChant, workspaceModules } from "./harness";

const TIMEOUT_MS = 180_000;
const LOCK = ".chant/workspace.lock.json";

function put(base: string, rel: string, content: string): void {
  mkdirSync(dirname(join(base, rel)), { recursive: true });
  writeFileSync(join(base, rel), content);
}

describe("chant #2551 — adopt-lineage and versions", () => {
  test(
    "a hand-copied project adopts the tag it came from, and versions reports it",
    async () => {
      const tpl = makeScratch("ws-adopt-tpl");
      git(tpl, ["init", "-q", "-b", "main"]);
      put(tpl, "README.md", "starter\n");
      put(tpl, "src/a.ts", "one\n");
      git(tpl, ["add", "-A"]);
      git(tpl, ["commit", "-q", "-m", "v1"]);
      git(tpl, ["tag", "v1.0.0"]);
      put(tpl, "src/a.ts", "two\n");
      git(tpl, ["commit", "-q", "-am", "v2"]);
      git(tpl, ["tag", "v2.0.0"]);

      // The family: two checkouts under one directory, each copied from a tag.
      const family = makeScratch("ws-adopt-family");
      git(family, ["init", "-q", "-b", "main"]);
      const projects: Record<string, string> = { old: "v1.0.0", new: "v2.0.0" };
      for (const [name, tag] of Object.entries(projects)) {
        const proj = join(family, name);
        mkdirSync(proj);
        execFileSync("tar", ["-x", "-C", proj], { input: execFileSync("git", ["archive", "--format=tar", tag], { cwd: tpl }) });
        git(proj, ["init", "-q", "-b", "main"]);
        git(proj, ["add", "-A"]);
        git(proj, ["commit", "-q", "-m", "copied by hand"]);
      }
      const proj = join(family, "old");

      const index = await runChant(family, ["workspace", "hash-index", "--from", tpl, "--output", "index.json"]);
      expect(index.exit, index.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(family, "index.json"), "utf-8")).tags.map((t: { tag: string }) => t.tag)).toEqual(["v1.0.0", "v2.0.0"]);

      const dry = await runChant(proj, ["workspace", "adopt-lineage", "--from", tpl, "--index", "../index.json", "--dry-run"]);
      expect(dry.exit, dry.stderr).toBe(0);
      expect(dry.stdout).toContain(`${tpl}@v1.0.0`);
      expect(dry.stdout).toContain("matched 2 of 2 template file(s)");
      expect(dry.stdout).toContain("from the cache, re-checked at the chosen tag");
      expect(existsSync(join(proj, LOCK))).toBe(false);

      const adopted = await runChant(proj, ["workspace", "adopt-lineage", "--from", tpl], { recordModules: true });
      expect(adopted.exit, adopted.stderr).toBe(0);
      expect(adopted.stderr).toContain("as adopted");
      expect(workspaceModules(adopted.modules).some((m) => m.endsWith("/workspace/lineage-adopt.ts"))).toBe(true);
      const lock = JSON.parse(readFileSync(join(proj, LOCK), "utf-8"));
      expect(lock.scopes["."]).toMatchObject({ ref: "v1.0.0", adoption: { provenance: "adopted", index: "computed", attestation: null } });

      const lineage = await runChant(proj, ["workspace", "lineage"]);
      expect(lineage.exit, lineage.stderr).toBe(0);
      expect(lineage.stdout).toContain("adopted");
      const again = await runChant(proj, ["workspace", "adopt-lineage", "--from", tpl]);
      expect(again.exit).toBe(1);
      expect(again.stderr).toContain("already has a lineage");

      const other = await runChant(join(family, "new"), ["workspace", "adopt-lineage", "--from", tpl]);
      expect(other.exit, other.stderr).toBe(0);

      const versions = await runChant(family, ["workspace", "versions", "--json"]);
      expect(versions.exit, versions.stderr).toBe(0);
      const report = JSON.parse(versions.stdout);
      expect(report.families).toEqual([
        {
          template: tpl,
          newest: "2.0.0",
          members: [
            { path: "new", scope: ".", ref: "v2.0.0", version: "2.0.0", behind: false },
            { path: "old", scope: ".", ref: "v1.0.0", version: "1.0.0", behind: true },
          ],
        },
      ]);
      const text = await runChant(family, ["workspace", "versions"]);
      expect(text.stdout).toContain(`family ${tpl}: 2 scope(s), newest 2.0.0; behind: old (v1.0.0)`);
    },
    TIMEOUT_MS,
  );

  test(
    "versions with no lock under the directory reports none",
    async () => {
      const dir = makeScratch("ws-versions-empty");
      git(dir, ["init", "-q", "-b", "main"]);
      const run = await runChant(dir, ["workspace", "versions"]);
      expect(run.exit, run.stderr).toBe(0);
      expect(run.stdout).toContain(`no ${LOCK} under`);
    },
    TIMEOUT_MS,
  );
});
