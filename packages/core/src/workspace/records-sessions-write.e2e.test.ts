/**
 * Sessions from a UI (#2693), through the command line: `records close` with
 * the declared session kind, and `records --since <session id>` without
 * --kind. Four CLI spawns put it near 13s on CI, close to the unit shards'
 * per-test budget, so it runs in the test-e2e job (#2817). The rest of #2693
 * is in records-sessions-write.test.ts.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, commitAll, contract, git, REPO } from "./__fixtures__/contract-repo";
import { declareSessions, newSessionFields, sessionsRepo, SESSIONS_KIND } from "./__fixtures__/sessions";
import closeSchema from "./records-close.schema.json";
import { type RecordsSinceDocument } from "./records-since";
import sinceSchema from "./records-since.schema.json";
import { newRecord } from "./records-write";
import newSchema from "./records-new.schema.json";

afterAll(cleanScratch);

const close = contract(closeSchema);
const since = contract(sinceSchema);
const created = contract(newSchema);

/** The reference fixture with a declaration, committed. */
function declared(): string {
  const root = sessionsRepo();
  declareSessions(root);
  commitAll(root, "declare");
  return root;
}

/** Open S-0002 through records new, and commit it. */
async function opened(root: string): Promise<{ path: string; head: string }> {
  const head = git(root, "rev-parse", "HEAD");
  const doc = await newRecord({ kind: SESSIONS_KIND, fields: newSessionFields(), cwd: root });
  created.expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  expect(doc.id).toBe("S-0002");
  commitAll(root, "open S-0002");
  return { path: doc.path, head };
}

describe("records --since <session id> (#2693)", () => {
  test(
    "through the CLI: close with the declared session kind, and --since <session id> without --kind",
    async () => {
      const root = declared();
      await opened(root);
      const run = (...args: string[]) =>
        spawnSync(process.execPath, ["--import", pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href, join(REPO, "packages/core/src/cli/main.ts"), "workspace", "records", ...args], {
          cwd: root,
          encoding: "utf-8",
          env: { ...process.env, NO_COLOR: "1" },
          timeout: 60_000,
        });
      const closed = run("close", "S-0002");
      expect(closed.status, closed.stderr).toBe(0);
      close.expectValid(JSON.parse(closed.stdout));
      const again = run("close", "S-0002");
      expect(again.status).toBe(1);
      expect(JSON.parse(again.stdout).error.code).toBe("record-closed");
      commitAll(root, "close");
      const set = run("--since", "S-0002", "--json");
      expect(set.status, set.stderr).toBe(0);
      const kinds = JSON.parse(set.stdout).kinds as RecordsSinceDocument[];
      for (const k of kinds) since.expectValid(k);
      expect(kinds.map((k) => ("session" in k ? k.session?.id : null))).toEqual(["S-0002", "S-0002"]);
      const text = run("--kind", SESSIONS_KIND, "--since", "S-0002");
      expect(text.stdout).toContain("session S-0002 (closed)");
      expect(text.stdout).toContain("S-0002  new, closed");
    },
    120_000,
  );
});
