/**
 * chant #2546 — `chant workspace records`, through the real CLI.
 *
 * The level-0 goldens in this directory prove no workspace module loads for a
 * level-0 command. This file is the other side: the workspace command does load
 * one, on first use, and reads the chant repo's own decision files. It also
 * holds the exit-code contract: invalid records exit 0 with reason codes, and
 * only a kind that cannot be read exits 1.
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import { git, makeScratch, REPO_ROOT, runChant, workspaceModules } from "./harness";

const TIMEOUT_MS = 120_000;
const DECISIONS = join(REPO_ROOT, "docs", "design", "decisions");
const KIND = "docs/design/decisions/decision.kind.mjs";

interface RecordsDoc {
  contract: number;
  current: boolean;
  records: Array<{ id: string | null; path: string; valid: boolean; reasons: Array<{ code: string }>; supersededBy: string | null }>;
  summary: { total: number; valid: number; invalid: number; superseded: number };
  error?: { code: string; message: string };
}

/** A git repo holding a copy of the chant repo's decisions, kind and schema. */
function decisionRepo(label: string): string {
  const root = makeScratch(label);
  mkdirSync(join(root, "docs", "design"), { recursive: true });
  cpSync(DECISIONS, join(root, "docs", "design", "decisions"), { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "decisions"]);
  return root;
}

describe("chant #2546 — workspace records", () => {
  test(
    "reads every chant decision as valid",
    async () => {
      const run = await runChant(REPO_ROOT, ["workspace", "records", "--kind", KIND, "--current", "--json"]);
      expect(run.stderr).toBe("");
      expect(run.exit).toBe(0);
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
    "a kind that cannot be read exits 1 with an error code",
    async () => {
      const root = decisionRepo("records-errors");
      const missing = await runChant(root, ["workspace", "records", "--kind", "nope.kind.mjs", "--json"]);
      expect(missing.exit).toBe(1);
      expect((JSON.parse(missing.stdout) as RecordsDoc).error?.code).toBe("kind-unreadable");
      const noKind = await runChant(root, ["workspace", "records", "--json"]);
      expect(noKind.exit).toBe(1);
      expect(noKind.stderr).toMatch(/--kind/);
    },
    TIMEOUT_MS,
  );
});
