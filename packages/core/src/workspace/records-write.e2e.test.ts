/**
 * `chant workspace records new|amend|review` (#2670) through the command
 * line: standard input, exit codes and the refusal document, from the CLI a
 * user runs. Each test spawns the CLI several times, which put them near 20s
 * on CI, over the unit shards' per-test budget, so they run in the test-e2e
 * job (#2817). The commands' own behaviour is covered in records-write.test.ts.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseFrontMatter } from "./records";
import { renderRecord } from "./records-write";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const DECISIONS = join(REPO, "docs", "design", "decisions");
const KIND = "decisions/decision.kind.mjs";

type Data = Record<string, unknown>;

const SAMPLE = (() => {
  const fm = parseFrontMatter(readFileSync(join(DECISIONS, "ws-003-seal-scope.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
})();

/** A decided decision like ws-003, with `over` laid on top. */
function decision(over: Data = {}): Data {
  return { ...structuredClone(SAMPLE), ...over };
}

/** A proposed decision: no choice, nobody decided. */
function proposal(over: Data = {}): Data {
  return decision({ state: "proposed", choice: null, decided_by: null, decided_on: null, ...over });
}

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-records-write-")));
  mkdirSync(join(dir, "decisions"));
  cpSync(join(DECISIONS, "decision.kind.mjs"), join(dir, "decisions", "decision.kind.mjs"));
  cpSync(join(DECISIONS, "decision.schema.json"), join(dir, "decisions", "decision.schema.json"));
  put("ws-001-one.md", decision({ id: "ws-001", title: "One" }));
  put("ws-002-two.md", proposal({ id: "ws-002", title: "Two" }));
  put("ws-003-three.md", decision({ id: "ws-003", title: "Three", state: "ratified" }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(name: string, data: Data): void {
  writeFileSync(join(dir, "decisions", name), renderRecord(data, `\n# ${String(data.title)}\n`));
}

describe("the command line", () => {
  const cli = (args: string[], input?: string) => {
    const loader = pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href;
    try {
      const out = execFileSync(process.execPath, ["--import", loader, join(REPO, "packages", "core", "src", "cli", "main.ts"), "workspace", "records", ...args], {
        cwd: dir,
        input,
        encoding: "utf-8",
        env: { ...process.env, TSX_DISABLE_CACHE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { status: 0, doc: JSON.parse(out) };
    } catch (err) {
      const e = err as { status: number; stdout: string };
      return { status: e.status, doc: JSON.parse(e.stdout) };
    }
  };

  test(
    "new reads fields from standard input, review appends, and a refusal exits 1 with its code",
    () => {
      const { id: _id, ...rest } = decision({ title: "From stdin" });
      const made = cli(["new", KIND, "--from", "-"], JSON.stringify(rest));
      expect(made).toMatchObject({ status: 0, doc: { id: "ws-004", path: "decisions/ws-004-from-stdin.md" } });
      expect(existsSync(join(dir, "decisions", "ws-004-from-stdin.md"))).toBe(true);
      const reviewed = cli(["review", "ws-004", "--kind", KIND, "--verdict", "agree", "--by", "alice"]);
      expect(reviewed).toMatchObject({ status: 0, doc: { review: { reviewer: "alice", verdict: "agree" } } });
      const refused = cli(["review", "ws-004", "--kind", KIND, "--verdict", "dissent", "--by", "bob"]);
      expect(refused).toMatchObject({ status: 1, doc: { error: { code: "review-note-required" } } });
      writeFileSync(join(dir, "patch.json"), JSON.stringify({ title: "Changed" }));
      expect(cli(["amend", "ws-004", "--kind", KIND, "--set", "patch.json"])).toMatchObject({ status: 1, doc: { error: { code: "amend-supersede-instead" } } });
      expect(cli(["amend", "ws-004", "--set", "patch.json"])).toMatchObject({ status: 1, doc: { error: { code: "write-usage-invalid" } } });
    },
    120_000,
  );

  test(
    "new --by writes the proposer, not the decider, and amend --by is refused rather than dropped (#2756)",
    () => {
      const { id: _id, ...rest } = decision({ title: "Kept by a session", state: "proposed", choice: null, decided_by: null, decided_on: null });
      const made = cli(["new", KIND, "--from", "-", "--by", "hud-session"], JSON.stringify(rest));
      expect(made).toMatchObject({ status: 0, doc: { id: "ws-004" } });
      const fm = parseFrontMatter(readFileSync(join(dir, "decisions", "ws-004-kept-by-a-session.md"), "utf-8"));
      if (!fm.ok) throw new Error(fm.message);
      expect(fm.value).toMatchObject({ proposed_by: "hud-session", decided_by: null });

      writeFileSync(join(dir, "patch.json"), JSON.stringify({ title: "Changed" }));
      const refused = cli(["amend", "ws-004", "--kind", KIND, "--set", "patch.json", "--by", "alice"]);
      expect(refused).toMatchObject({ status: 1, doc: { error: { code: "write-usage-invalid", message: expect.stringContaining("--by is not taken by amend") } } });
    },
    120_000,
  );
});
