/**
 * chant #2546 — `chant workspace records`, through the real CLI.
 *
 * The level-0 goldens in this directory prove no workspace module loads for a
 * level-0 command. This file is the other side: the workspace command does load
 * one, on first use, and reads the chant repo's own decision files. It also
 * holds the exit-code contract: invalid records exit 0 with reason codes, and
 * only a kind or revision that cannot be read exits 1.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import { chantEnv, git, makeScratch, REPO_ROOT, runChant, workspaceModules } from "./harness";

const TIMEOUT_MS = 120_000;
const DECISIONS = join(REPO_ROOT, "docs", "design", "decisions");
const KIND = "docs/design/decisions/decision.kind.mjs";

interface RecordsDoc {
  contract: number;
  at: string | null;
  current: boolean;
  records: Array<{
    id: string | null;
    path: string;
    valid: boolean;
    reasons: Array<{ code: string }>;
    warnings: Array<{ code: string; message: string }>;
    supersededBy: string | null;
  }>;
  summary: { total: number; valid: number; invalid: number; superseded: number };
  error?: { code: string; message: string };
}

/**
 * A git repo holding a copy of the chant repo's decisions, kind and schema,
 * and the design notes a decision pins by hash (ws-053 pins its note).
 * `extraRecords` adds more decision files (name to content) before the commit,
 * for a case the repo's own decisions don't happen to cover.
 */
function decisionRepo(label: string, extraRecords: Record<string, string> = {}): string {
  const root = makeScratch(label);
  mkdirSync(join(root, "docs", "design"), { recursive: true });
  cpSync(DECISIONS, join(root, "docs", "design", "decisions"), { recursive: true });
  cpSync(join(REPO_ROOT, "docs", "design", "workspace"), join(root, "docs", "design", "workspace"), { recursive: true });
  for (const [name, text] of Object.entries(extraRecords)) {
    writeFileSync(join(root, "docs", "design", "decisions", name), text);
  }
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "decisions"]);
  return root;
}

/**
 * ws-001 with a fresh id and an evidence pin on a workspace file this fixture
 * never copies in (#2745): the asset is missing in both the working tree and
 * `--at` readings, and the two readings must word that the same way.
 */
function recordWithMissingPin(): string {
  return readFileSync(join(DECISIONS, "ws-001-trust-root.md"), "utf-8")
    .replace(/^id: .*$/m, 'id: "ws-901"')
    .replace(/^title: .*$/m, 'title: "A record whose evidence pins a file outside this fixture"')
    .replace(
      /^evidence:\n(?:  .*\n)*decided_by:/m,
      `evidence:\n  - title: "a workspace file this fixture does not hold"\n    path: "packages/core/src/workspace/records.ts"\n    sha256: "${"0".repeat(64)}"\ndecided_by:`,
    );
}

describe("chant #2546 — workspace records", () => {
  test(
    "reads every chant decision as valid",
    async () => {
      // Spawned directly: runChant lists the directory's ignored files after the
      // run, and at the repo root that walks all of node_modules.
      const run = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs")).href, join(REPO_ROOT, "packages/core/src/cli/main.ts"), "workspace", "records", "--kind", KIND, "--current", "--json"],
        { cwd: REPO_ROOT, env: chantEnv(), encoding: "utf-8", timeout: TIMEOUT_MS },
      );
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      const doc = JSON.parse(run.stdout) as RecordsDoc;
      expect(doc.contract).toBe(1);
      expect(doc.summary.invalid).toBe(0);
      expect(doc.summary.total).toBeGreaterThanOrEqual(50);
      expect(doc.records.every((r) => r.valid && r.id !== null)).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "loads the workspace module on first use, and only for this command",
    async () => {
      // Run in a copy: the recorder writes its log beside the directory it runs in.
      const root = decisionRepo("records-modules");
      const run = await runChant(root, ["workspace", "records", "--kind", KIND, "--json"], { recordModules: true });
      expect(run.exit).toBe(0);
      expect(workspaceModules(run.modules)).toContain(join(REPO_ROOT, "packages/core/src/workspace/records-cli.ts"));
      expect(run.modules).toContain(pathToFileURL(join(REPO_ROOT, "packages/core/src/cli/main.ts")).href);
    },
    TIMEOUT_MS,
  );

  test(
    "--at reads the committed files and matches a clean working tree",
    async () => {
      const root = decisionRepo("records-at", { "ws-901-missing-pin.md": recordWithMissingPin() });
      const tree = await runChant(root, ["workspace", "records", "--kind", KIND, "--current", "--json"]);
      const head = git(root, ["rev-parse", "HEAD"]).trim();
      const at = await runChant(root, ["workspace", "records", "--kind", KIND, "--current", "--json", "--at", "HEAD"]);
      expect(at.exit).toBe(0);
      const a = JSON.parse(tree.stdout) as RecordsDoc;
      const b = JSON.parse(at.stdout) as RecordsDoc;
      expect(a.at).toBeNull();
      expect(b.at).toBe(head);
      expect(b.records).toEqual(a.records);

      // The missing pin warns the same way whether it's read from the tree or
      // from the revision (#2745): the message names no revision either way.
      const pinned = a.records.find((r) => r.id === "ws-901")!;
      expect(pinned.warnings).toEqual([{ code: "asset-missing", message: "evidence pins packages/core/src/workspace/records.ts, which does not exist" }]);

      // An edit to the working tree changes the tree read, not the read at HEAD.
      writeFileSync(join(root, "docs/design/decisions/ws-001-trust-root.md"), "not a record any more\n");
      const edited = JSON.parse((await runChant(root, ["workspace", "records", "--kind", KIND, "--json"])).stdout) as RecordsDoc;
      const still = JSON.parse((await runChant(root, ["workspace", "records", "--kind", KIND, "--json", "--at", head])).stdout) as RecordsDoc;
      expect(edited.summary.invalid).toBe(1);
      expect(still.summary.invalid).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "a malformed file, a schema violation and a broken supersedes link each get a reason code, and the command exits 0",
    async () => {
      const root = decisionRepo("records-invalid");
      const dir = join(root, "docs/design/decisions");
      const edit = (file: string, from: RegExp, to: string) => {
        const path = join(dir, file);
        writeFileSync(path, readFileSync(path, "utf-8").replace(from, to));
      };
      writeFileSync(join(dir, "ws-001-trust-root.md"), "# no front matter\n");
      edit("ws-002-local-promise.md", /^state: .*$/m, 'state: "maybe"');
      edit("ws-003-seal-scope.md", /^supersedes: \[\]$/m, 'supersedes:\n  - decision: "ws-999"');
      const run = await runChant(root, ["workspace", "records", "--kind", KIND, "--current", "--json"]);
      expect(run.exit).toBe(0);
      const doc = JSON.parse(run.stdout) as RecordsDoc;
      const reasons = Object.fromEntries(doc.records.slice(0, 3).map((r) => [r.path.split("/").pop(), r.reasons.map((x) => x.code)]));
      expect(reasons).toEqual({
        "ws-001-trust-root.md": ["record-unparseable"],
        "ws-002-local-promise.md": ["record-schema-invalid"],
        "ws-003-seal-scope.md": ["record-supersedes-unknown"],
      });
      expect(doc.summary.invalid).toBe(3);
    },
    TIMEOUT_MS,
  );

  test(
    "a kind that cannot be read or an unknown revision exits 1 with an error code",
    async () => {
      const root = decisionRepo("records-errors");
      const missing = await runChant(root, ["workspace", "records", "--kind", "nope.kind.mjs", "--json"]);
      expect(missing.exit).toBe(1);
      expect((JSON.parse(missing.stdout) as RecordsDoc).error?.code).toBe("kind-unreadable");
      const badRev = await runChant(root, ["workspace", "records", "--kind", KIND, "--json", "--at", "no-such-rev"]);
      expect(badRev.exit).toBe(1);
      expect((JSON.parse(badRev.stdout) as RecordsDoc).error?.code).toBe("revision-unknown");
      const noKind = await runChant(root, ["workspace", "records", "--json"]);
      expect(noKind.exit).toBe(1);
      expect(noKind.stderr).toMatch(/--kind/);
    },
    TIMEOUT_MS,
  );
});
