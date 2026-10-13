/**
 * chant #2552 — `chant workspace export`, `import` and `admit` through the
 * real CLI: a member made from a template with a host-bound parameter is
 * exported with that value switched, changed in the export, and imported
 * back with the host's value restored.
 *
 * The level-0 side is pinned by level0-goldens.test.ts, which asserts that no
 * level-0 command loads a module under `workspace/`. These commands are
 * workspace code, loaded only when they run.
 */

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

describe("chant #2552 — export and import", () => {
  test(
    "a member exports with its host-bound value switched, and imports back with it restored",
    async () => {
      const tpl = makeScratch("ws-export-tpl");
      git(tpl, ["init", "-q", "-b", "main"]);
      put(tpl, "server.txt", "hello\n");
      put(tpl, "config.txt", "domain={{chant:domain}}\n");
      put(
        tpl,
        "chant.template.json",
        JSON.stringify({ parameters: { domain: { type: "string", default: "localhost", hostBound: true } }, files: ["config.txt"] }),
      );
      git(tpl, ["add", "-A"]);
      git(tpl, ["commit", "-q", "-m", "v1"]);
      git(tpl, ["tag", "v1.0.0"]);

      const ws = makeScratch("ws-export-host");
      git(ws, ["init", "-q", "-b", "main"]);
      const init = await runChant(ws, ["init", "--from", `${tpl}@v1.0.0`, "app", "--param", "domain=studio.example.test"]);
      expect(init.exit, init.stderr).toBe(0);
      const lock = JSON.parse(readFileSync(join(ws, "app", LOCK), "utf-8"));
      expect(lock.scopes["."].hostBound).toEqual({ domain: ["config.txt"] });
      put(
        ws,
        "chant.workspace.json",
        JSON.stringify({
          name: "acme",
          schema: 1,
          members: [
            { name: "app", dir: "app", kind: "other", because: "made from a template", travel: true },
            { name: "out", dir: "out", kind: "workspace", roles: ["export"] },
          ],
        }),
      );
      git(ws, ["add", "-A"]);
      git(ws, ["commit", "-q", "-m", "host"]);

      const exported = await runChant(ws, ["workspace", "export", "--param", "domain=copy.example.test"], { recordModules: true });
      expect(exported.exit, exported.stderr).toBe(0);
      expect(workspaceModules(exported.modules).some((m) => m.endsWith("/workspace/export.ts"))).toBe(true);
      expect(exported.stdout).toContain("host values switched in: app/config.txt");
      expect(readFileSync(join(ws, "out/app/config.txt"), "utf-8")).toBe("domain=copy.example.test\n");
      expect(existsSync(join(ws, "out/.chant/export.json"))).toBe(true);
      const ls = await runChant(join(ws, "out"), ["workspace", "ls", "--json"]);
      expect(ls.exit, ls.stderr).toBe(0);
      expect(JSON.parse(ls.stdout).members.map((m: { name: string }) => m.name)).toEqual(["app"]);
      git(ws, ["add", "-A"]);
      git(ws, ["commit", "-q", "-m", "export"]);

      put(ws, "out/app/server.txt", "hello from the copy\n");
      const dry = await runChant(ws, ["workspace", "import", "--dry-run"]);
      expect(dry.exit, dry.stderr).toBe(0);
      expect(dry.stdout).toContain("write   app/server.txt");
      expect(readFileSync(join(ws, "app/server.txt"), "utf-8")).toBe("hello\n");

      const imported = await runChant(ws, ["workspace", "import", "--json"]);
      expect(imported.exit, imported.stderr).toBe(0);
      const report = JSON.parse(imported.stdout);
      expect(report.written).toEqual(["app/server.txt"]);
      expect(report.member).toMatchObject({ name: "out", action: "regenerated" });
      expect(readFileSync(join(ws, "app/server.txt"), "utf-8")).toBe("hello from the copy\n");
      expect(readFileSync(join(ws, "app/config.txt"), "utf-8")).toBe("domain=studio.example.test\n");
      expect(existsSync(join(ws, report.returnRecord))).toBe(true);

      // The copy was the export member, not a repository of its own, so no commit signed it.
      const admit = await runChant(ws, ["workspace", "admit", report.return.id]);
      expect(admit.exit).toBe(1);
      expect(admit.stderr).toContain("names no signer");
    },
    TIMEOUT_MS,
  );
});
