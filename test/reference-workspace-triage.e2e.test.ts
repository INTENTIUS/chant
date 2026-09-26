/**
 * The reference workspace's decision points, end to end (#2741, ws-058): on a
 * copy of the fixture, a finding `graph --intent` reports is asked through the
 * decide activity, a stub decider's answer is a proposal, the work item written
 * from it opens proposed with its proposer in proposed_by, and a person keeps
 * both. A finding `check --changes` reports goes through the same triage
 * (#2794).
 *
 * Split from test/reference-workspace.test.ts (#2817): the first test's six CLI
 * spawns put it at about 20s on CI, over the unit shards' per-test budget, so
 * both run in the test-e2e job.
 */

import { describe, expect, test } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { queryRecords } from "@intentius/chant/workspace/records-cli";
import { askPoint } from "@intentius/chant/workspace/decide";
import { changeFindingTriageInputs, checkChanges, type ChangesDocument } from "@intentius/chant/workspace/changes";
import { isPointWait } from "@intentius/chant/op";
import { startStubBackend } from "@intentius/chant/op/__fixtures__/decide-stub-backend";
import { runDecide } from "@intentius/chant/op/activities/decide";

const repoRoot = resolve(import.meta.dirname, "..");
const fixture = join(repoRoot, "reference-workspace");
const CLI_TIMEOUT_MS = 60_000;

/** node's own argv for a `chant` invocation: the tsx loader hook, then the CLI entry, then `args`. */
function chantArgv(...args: string[]): string[] {
  return ["--import", pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href, join(repoRoot, "packages/core/src/cli/main.ts"), ...args];
}

/** Run this checkout's chant CLI in `cwd`, as a user would. */
function chant(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, chantArgv(...args), { cwd, encoding: "utf-8", timeout: CLI_TIMEOUT_MS, env: { ...process.env, NO_COLOR: "1" } });
}

/**
 * Same as `chant`, but non-blocking: the child runs while the caller does other
 * work on the main thread, instead of the two serializing (chant #2777, ws-058).
 */
function chantAsync(cwd: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, chantArgv(...args), { cwd, timeout: CLI_TIMEOUT_MS, env: { ...process.env, NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", rej);
    child.on("close", (status) => res({ status, stdout, stderr }));
  });
}

describe("decision points on the work graph (#2741, ws-058)", () => {
  const on = "2026-09-25";

  test("a finding produces a triage question, the stub decider's answer becomes a proposed work item, and a person keeps it", async () => {
    // 1. graph --intent reports the finding, on the fixture as committed. This read does
    // not depend on the scratch repo built below, so it runs concurrently with that setup
    // instead of serializing in front of it (chant #2777, ws-058).
    const graphPromise = chantAsync(fixture, "workspace", "graph", "--intent", "app/src/server.mjs", "--json");

    // The rest writes, so it runs on a copy of the fixture in its own repository.
    const scratch = mkdtempSync(join(tmpdir(), "chant-2741-triage-"));
    const root = join(scratch, "ws");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    const stub = await startStubBackend({
      answers: { "finding-triage": { type: "choice", choice: "work-item", probabilities: { "work-item": 0.9, "needs-a-decision": 0.06, leave: 0.04 }, confidence: 0.86 } },
    });
    try {
      cpSync(fixture, root, { recursive: true, filter: (src) => !/(^|\/)(node_modules|dist)(\/|$)/.test(src.slice(fixture.length)) });
      git("init", "-q");
      git("add", "-A");
      git("commit", "-q", "-m", "the reference workspace");

      const graph = await graphPromise;
      expect(graph.status, graph.stderr).toBe(0);
      type Node = { id: string; kind: string; code?: string; message?: string; addressed?: boolean; addressedBy?: { id: string; state: string }[]; path?: string; member?: string; generated?: boolean };
      const nodesOf = (text: string) => (JSON.parse(text) as { region: string; nodes: Node[] });
      const g = nodesOf(graph.stdout);
      const region = g.nodes.find((n) => n.id === g.region)!;
      const finding = g.nodes.find((n) => n.kind === "finding" && n.code === "intent-constraint-coarse")!;
      expect(finding, "graph --intent app/src/server.mjs reports intent-constraint-coarse").toBeDefined();
      expect(finding.addressed).toBe(false);
      const inputs = {
        "finding.code": finding.code,
        "finding.message": finding.message,
        "finding.addressed": finding.addressed,
        "region.path": region.path,
        "region.member": region.member,
        "region.generated": region.generated,
      };

      // 2. The decide activity asks finding-triage. No table row matches, the stub decider answers
      //    work-item above the threshold, and the answer is a proposal: the run waits on it.
      const backends = { systemone: { url: stub.url } };
      const wait = await runDecide({ cwd: root, point: "finding-triage", inputs, subject: "app/src/server.mjs", backends }, { on }).then(
        (r) => {
          throw new Error(`expected the run to wait on a proposal, and decide returned ${JSON.stringify(r)}`);
        },
        (err: unknown) => {
          if (!isPointWait(err)) throw err;
          return err.question;
        },
      );
      expect(wait).toMatchObject({ point: "finding-triage", state: "proposed", subject: "app/src/server.mjs" });
      expect(stub.requests.map((r) => [r.model, Object.keys(r.questions)])).toEqual([["jev-1.13.0", ["finding-triage"]]]);

      // The read contract lists it as an open question with the model's answer, for hud to prompt a person.
      const listed = chant(root, "workspace", "points", "--open", "--json");
      expect(listed.status, listed.stderr).toBe(0);
      const open = (JSON.parse(listed.stdout) as { questions: { id: string; state: string; answer: unknown; confidence: number; decider: { kind: string; model?: string } }[] }).questions;
      // The fixture's own slice-tier proposal for W-002 is open too.
      expect(open.map((q) => [q.id, q.state, q.answer, q.decider.kind, q.decider.model, q.confidence])).toEqual([
        [wait.id, "proposed", "work-item", "model", "jev-1.13.0", 0.86],
        ["slice-tier-074b660bbaad", "proposed", "medium", "model", "bosun-v3.1-1.7b", 0.865],
      ]);

      // 3. The runtime writes the work item the answer proposes, naming the decider as its proposer.
      const fields = {
        schema: 1,
        title: "Constrain app/src/server.mjs by path",
        implements: [],
        needs: [],
        constrains: ["path:app/src/server.mjs"],
        evidence: [],
        opened_on: on,
        source: { finding: finding.code, region: region.path, answer: wait.id },
        supersedes: [],
      };
      writeFileSync(join(scratch, "work.json"), JSON.stringify({ ...fields, state: "proposed" }));
      const made = chant(root, "workspace", "records", "new", "work", "--from", join(scratch, "work.json"), "--by", "jev-1.13.0", "--json");
      expect(made.status, made.stderr + made.stdout).toBe(0);
      expect(JSON.parse(made.stdout)).toMatchObject({ id: "W-003" });
      const work = async () => {
        const doc = await queryRecords({ kind: "work/work.kind.mjs", cwd: root });
        if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
        return doc.records.find((r) => r.id === "W-003") as unknown as { state: string; valid: boolean; ready: boolean; data: Record<string, unknown> };
      };
      expect(await work()).toMatchObject({ state: "proposed", valid: true, ready: false, data: { proposed_by: "jev-1.13.0", source: { answer: wait.id } } });

      // 4. A person keeps it: confirms the triage answer, and moves the work item to open.
      const answered = chant(root, "workspace", "points", "answer", wait.id, "--answer", "work-item", "--by", "alice", "--json");
      expect(answered.status, answered.stderr + answered.stdout).toBe(0);
      expect(JSON.parse(answered.stdout)).toMatchObject({ question: { state: "answered", answer: "work-item", answeredBy: ["alice"] } });
      writeFileSync(join(scratch, "keep.json"), JSON.stringify({ state: "open" }));
      const kept = chant(root, "workspace", "records", "amend", "W-003", "--kind", "work", "--set", join(scratch, "keep.json"), "--json");
      expect(kept.status, kept.stderr + kept.stdout).toBe(0);
      expect(await work()).toMatchObject({ state: "open", valid: true, ready: true, data: { proposed_by: "jev-1.13.0" } });

      // 5. Once committed, the finding reads as addressed by W-003, and asking the triage for it again, the table leaves it.
      git("add", "-A");
      git("commit", "-q", "-m", "W-003 kept");
      const after = chant(root, "workspace", "graph", "--intent", "app/src/server.mjs", "--json");
      expect(after.status, after.stderr).toBe(0);
      const again = nodesOf(after.stdout).nodes.find((n) => n.kind === "finding" && n.code === "intent-constraint-coarse")!;
      expect([again.addressed, again.addressedBy]).toEqual([true, [{ id: "W-003", state: "open" }]]);
      const left = await runDecide({ cwd: root, point: "finding-triage", inputs: { ...inputs, "finding.addressed": true }, subject: "app/src/server.mjs", backends }, { on });
      expect(left).toMatchObject({ state: "answered", answer: "leave", decider: "table" });
      expect(stub.requests).toHaveLength(1);
    } finally {
      await stub.close();
      rmSync(scratch, { recursive: true, force: true });
    }
    // Six chant CLI spawns (five of them serial by data dependency) plus two in-process
    // decide calls: on CI, each spawn cold-transforms the CLI's TypeScript from source (no
    // build step runs before `vitest run` there, and this repo ships no compiled CLI at
    // all, chant #2803), so the cost does not amortize across the six. It ran 19s to 21s
    // in the unit shards, over their 15s per-test budget, which is why it is here (#2817).
  }, 60_000);

  test("a change finding from check --changes goes through the same triage: a model proposal, then left once a work item names its gap (#2794)", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "chant-2794-change-triage-"));
    const root = join(scratch, "ws");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const commit = (message: string) => {
      git("add", "-A");
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    };
    const stub = await startStubBackend({
      answers: { "finding-triage": { type: "choice", choice: "work-item", probabilities: { "work-item": 0.9, "needs-a-decision": 0.06, leave: 0.04 }, confidence: 0.86 } },
    });
    type Doc = Exclude<ChangesDocument, { error: unknown }>;
    const checked = async (range: string): Promise<Doc> => {
      const { doc } = await checkChanges({ cwd: root, range });
      if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
      return doc;
    };
    const region = "docs/record-decisions.md";
    try {
      cpSync(fixture, root, { recursive: true, filter: (src) => !/(^|\/)(node_modules|dist)(\/|$)/.test(src.slice(fixture.length)) });
      git("init", "-q");
      const c0 = commit("the reference workspace");
      // docs/ is no member, and no record constrains it.
      writeFileSync(join(root, region), `${readFileSync(join(root, region), "utf-8")}\nOne more line.\n`);
      const c1 = commit("an edit no record covers");

      // 1. check --changes prints the finding with everything the point reads: addressed on the finding, member and generated on its path.
      const run = chant(root, "workspace", "check", "--changes", `${c0}..${c1}`, "--json");
      expect(run.status, run.stderr).toBe(0);
      const doc = JSON.parse(run.stdout) as Doc;
      expect(doc.findings.map((f) => [f.code, f.path, f.addressed])).toEqual([["change-uncovered", region, false]]);
      const [finding] = doc.findings;
      const inputs = changeFindingTriageInputs(finding, doc.paths.find((p) => p.path === finding.path)!);
      expect(inputs).toEqual({
        "finding.code": "change-uncovered",
        "finding.message": finding.message,
        "finding.addressed": false,
        "region.path": region,
        "region.member": null,
        "region.generated": false,
      });

      // 2. No table row names change-uncovered, so the stub model answers work-item above its threshold, and the run waits on the proposal.
      const backends = { systemone: { url: stub.url } };
      const wait = await runDecide({ cwd: root, point: "finding-triage", inputs, subject: region, backends }, { on }).then(
        (r) => {
          throw new Error(`expected the run to wait on a proposal, and decide returned ${JSON.stringify(r)}`);
        },
        (err: unknown) => {
          if (!isPointWait(err)) throw err;
          return err.question;
        },
      );
      expect(wait).toMatchObject({ point: "finding-triage", state: "proposed", subject: region });
      expect(stub.requests.map((r) => [r.model, Object.keys(r.questions)])).toEqual([["jev-1.13.0", ["finding-triage"]]]);

      // 3. The work item the answer proposes names the finding's triage as its source. Kept open and committed,
      //    it covers the path, so a check whose head holds it has no finding.
      const item = (state: string, extra: Record<string, unknown> = {}) => {
        const data = { schema: 1, id: "W-003", title: "Record why the decisions doc changed", state, implements: [], needs: [], constrains: [`path:${region}`], evidence: [], opened_on: on, source: { ...finding.triage, answer: wait.id }, supersedes: [], ...extra };
        writeFileSync(join(root, "work", "W-003-record-why-the-decisions-doc-changed.md"), `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${data.title}\n`);
      };
      item("open");
      const c2 = commit("W-003 from the triage");
      const covered = await checked(`${c0}..${c2}`);
      expect(covered.paths.find((p) => p.path === region)).toMatchObject({ status: "covered", coveredBy: [{ record: "work/W-003", state: "open", entry: `path:${region}` }] });
      expect(covered.findings).toEqual([]);

      // 4. A person drops it. A dropped item covers nothing, so the finding fires again, now addressed by W-003,
      //    and the triage's first row leaves it without asking the model.
      item("dropped", { closed_on: on });
      const c3 = commit("W-003 dropped");
      const again = await checked(`${c0}..${c3}`);
      expect(again.findings.map((f) => [f.code, f.path, f.addressed, f.addressedBy])).toEqual([["change-uncovered", region, true, [{ record: "work/W-003", state: "dropped" }]]]);
      const left = await runDecide(
        { cwd: root, point: "finding-triage", inputs: changeFindingTriageInputs(again.findings[0], again.paths.find((p) => p.path === region)!), subject: region, backends },
        { on },
      );
      expect(left).toMatchObject({ state: "answered", answer: "leave", decider: "table" });
      expect(stub.requests).toHaveLength(1);

      // A change-out-of-scope finding never reaches the model: the table sends it to a decision.
      const scope = await askPoint({ cwd: root, point: "finding-triage", inputs: { ...inputs, "finding.code": "change-out-of-scope" }, subject: region, on, dryRun: true });
      if ("error" in scope) throw new Error(`${scope.error.code}: ${scope.error.message}`);
      expect(scope.question).toMatchObject({ state: "answered", answer: "needs-a-decision", decider: { kind: "table", row: 3 } });
    } finally {
      await stub.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});
