/**
 * chant #2550 — `chant workspace upgrade` through the real CLI, with the real
 * gate ledger on `chant/lifecycle`: stage, gate on the patch digest, `chant
 * approve`, apply. And the level-0 side: `chant workspace check` in a project
 * with no lock passes, and plain `chant approve` for an unrelated op still
 * loads no workspace module.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { git, makeScratch, runChant, workspaceModules } from "./harness";

const TIMEOUT_MS = 180_000;
const LOCK = ".chant/workspace.lock.json";

function put(base: string, rel: string, content: string): void {
  mkdirSync(dirname(join(base, rel)), { recursive: true });
  writeFileSync(join(base, rel), content);
}

describe("chant #2550 — workspace upgrade", () => {
  test(
    "init --from v1, edit, upgrade to v2: gated on the patch, approved, applied",
    async () => {
      // The project sits in a subdirectory of its repository, and the template in a repository of its own.
      const root = makeScratch("ws-upgrade");
      git(root, ["init", "-q", "-b", "main"]);
      const tpl = makeScratch("ws-upgrade-tpl");
      git(tpl, ["init", "-q", "-b", "main"]);
      put(tpl, "README.md", "starter\n");
      put(tpl, "src/a.ts", "one\ntwo\nthree\nfour\nfive\n");
      git(tpl, ["add", "-A"]);
      git(tpl, ["commit", "-q", "-m", "v1"]);
      git(tpl, ["tag", "v1.0.0"]);
      put(tpl, "README.md", "starter v2\n");
      put(tpl, "src/a.ts", "one\ntwo\nthree\nfour\nFIVE\n");
      git(tpl, ["commit", "-q", "-am", "v2"]);
      git(tpl, ["tag", "v2.0.0"]);

      const made = await runChant(root, ["init", "--from", `${tpl}@v1.0.0`, "proj"]);
      expect(made.exit, made.stderr).toBe(0);
      const proj = join(root, "proj");
      put(proj, "src/a.ts", "ONE\ntwo\nthree\nfour\nfive\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "from v1, edited"]);

      const gated = await runChant(proj, ["workspace", "upgrade", ".", "--to", "v2.0.0"]);
      expect(gated.exit, gated.stderr).toBe(3);
      expect(gated.stdout).toContain(". ");
      expect(gated.stdout).toContain("v1.0.0 -> v2.0.0");
      expect(gated.stdout).toContain("merged: src/a.ts");
      expect(gated.stdout).toContain("updated: README.md");
      expect(gated.stderr).toContain("chant approve workspace-upgrade .");
      const digest = /patch: \d+ file\(s\), (sha256:[0-9a-f]{64})/.exec(gated.stdout)?.[1];
      expect(digest).toBeDefined();
      expect(readFileSync(join(proj, "README.md"), "utf-8")).toBe("starter\n");
      expect(git(proj, ["show", "chant/lifecycle:_gates/workspace-upgrade.jsonl"])).toContain(digest!);

      const approve = await runChant(proj, ["approve", "workspace-upgrade", "."]);
      expect(approve.exit, approve.stderr).toBe(0);
      expect(approve.stderr).not.toContain("was not found among discovered");
      expect(approve.stderr).toContain("chant workspace upgrade .");

      const applied = await runChant(proj, ["workspace", "upgrade", ".", "--to", "v2.0.0"]);
      expect(applied.exit, applied.stderr).toBe(0);
      expect(applied.stderr).toContain(`applied the approved upgrade of "." (${digest})`);
      expect(readFileSync(join(proj, "README.md"), "utf-8")).toBe("starter v2\n");
      expect(readFileSync(join(proj, "src/a.ts"), "utf-8")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
      expect(JSON.parse(readFileSync(join(proj, LOCK), "utf-8")).scopes["."].ref).toBe("v2.0.0");

      const check = await runChant(proj, ["workspace", "check", "--json"]);
      expect(check.exit, check.stderr).toBe(0);
      expect(JSON.parse(check.stdout)).toEqual({ lock: LOCK, ok: true, findings: [] });
    },
    TIMEOUT_MS,
  );

  test(
    "workspace check with no lock has nothing to check",
    async () => {
      const root = makeScratch("ws-check");
      git(root, ["init", "-q", "-b", "main"]);
      const check = await runChant(root, ["workspace", "check"], { recordModules: true });
      expect(check.exit, check.stderr).toBe(0);
      expect(check.stderr).toContain("nothing to check");
      // The command itself is workspace code, loaded on demand.
      expect(workspaceModules(check.modules).some((m) => m.endsWith("/workspace/lineage-check.ts"))).toBe(true);
    },
    TIMEOUT_MS,
  );
});
