/**
 * The why chain of `graph --intent` (#4023), over a workspace in a throwaway
 * git repository whose `chant/lifecycle` ledgers are written through the
 * library, so the test needs no deploy. The end-to-end chain, with a real
 * cut, a gated `components promote --release` and an approval, is in
 * cli/handlers/intent-trace.e2e.test.ts.
 *
 * - c1 adds the workspace, the work kind, W-001 (constrains app/server.mjs)
 *   and the server.
 * - c2 changes the server with `Chant-Record: work:W-001`: linked, green, and
 *   release v1 is cut from it and deployed to prod through the release gate.
 * - c3 changes the server with no trailer: unlinked, in W-001's window, and
 *   revoked. A plain deploy of it reaches dev through a component gate, with
 *   a release plan in `_plans/`.
 * - c4 changes the README: green, release v2 is cut from it, so v2 contains
 *   c2 and c3. Its staging deploy names no releaseDigest and joins v2
 *   through its release gate admission.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { appendGateResolution } from "../lifecycle/gate-ledger";
import { persistReleasePlan } from "../lifecycle/plan-ledger";
import { appendReleaseRecord } from "../lifecycle/release-ledger";
import { appendCut, makeRelease, persistRelease, type Release } from "../lifecycle/release-store";
import { cleanScratch, contract, git, REPO, repo, writeFiles } from "./__fixtures__/contract-repo";
import { intentGraph, type IntentDocument } from "./intent";
import intentSchema from "./intent.schema.json";
import { traceLines } from "./intent-cli";

const REF = join(REPO, "reference-workspace");
const KIND_FILES = {
  "work/work.kind.mjs": readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8"),
  "work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8"),
  "decisions/decision.kind.mjs": readFileSync(join(REF, "decisions", "decision.kind.mjs"), "utf-8"),
  "decisions/decision.schema.json": readFileSync(join(REF, "decisions", "decision.schema.json"), "utf-8"),
};
const W001 = `---\n${JSON.stringify({ schema: 1, id: "W-001", title: "Serve on 8081", state: "open", implements: [], needs: [], constrains: ["path:app/server.mjs"], evidence: [], opened_on: "2026-10-16", supersedes: [] }, null, 2)}\n---\n\n# W-001\n`;
const DECLARATION = JSON.stringify({ name: "shop", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "a plain Node server" }] });
const PLAN = `jcs1-sha256:${"b".repeat(64)}`;
const DEV_PLAN = `sha256:${"0123456789abcdef".repeat(4)}`;

let root: string;
let app: string;
const sha: Record<string, string> = {};
let v1: Release;
let v2: Release;

function commit(name: string, message: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  sha[name] = git(root, "rev-parse", "HEAD");
}

const subject = (commitSha: string) => ({ member: "app", commit: commitSha, artifactDigests: [{ component: "api", kind: "image" as const, path: "api.tar", digest: `sha256:${commitSha.slice(0, 8).padEnd(64, "0")}` }], targets: [{ env: "prod", templates: [], params: [] }] });

beforeAll(async () => {
  root = repo({ "chant.workspace.json": DECLARATION, "app/server.mjs": "export const port = 8080;\n", "README.md": "shop\n", "work/W-001-port.md": W001, ...KIND_FILES });
  app = join(root, "app");
  commit("c1", "the shop and W-001");
  writeFiles(root, { "app/server.mjs": "export const port = 8081;\n" });
  commit("c2", "serve on 8081\n\nChant-Record: work:W-001");
  writeFiles(root, { "app/server.mjs": "export const port = 8081;\nexport const host = '0.0.0.0';\n" });
  commit("c3", "listen on every interface");
  writeFiles(root, { "README.md": "shop, on 8081\n" });
  commit("c4", "say the port");
  git(root, "tag", `ci/green/${sha.c2}`, sha.c2);
  git(root, "tag", `ci/revoked/${sha.c3}`, sha.c3);
  git(root, "tag", `ci/green/${sha.c4}`, sha.c4);

  const loc = { cwd: app };
  v1 = makeRelease(subject(sha.c2));
  v2 = makeRelease(subject(sha.c4));
  for (const [r, label, at] of [[v1, "v1", "2026-10-16T10:00:00.000Z"], [v2, "v2", "2026-10-16T12:00:00.000Z"]] as const) {
    await persistRelease(r, [], loc);
    await appendCut({ releaseDigest: r.releaseDigest, label, actor: "alice", timestamp: at, runOrigin: null }, loc);
  }
  await appendGateResolution({ op: "release", gate: "prod-release", resolvedBy: "bob", origin: "cli", timestamp: "2026-10-16T10:30:00.000Z", planDigest: PLAN, environment: "prod", releaseDigest: v1.releaseDigest }, loc);
  await appendGateResolution({ op: "release", gate: "staging-release", resolvedBy: "carol", origin: "mcp", timestamp: "2026-10-16T12:30:00.000Z", planDigest: PLAN, environment: "staging", releaseDigest: v2.releaseDigest }, loc);
  await appendGateResolution({ op: "api", gate: "dev-gate", resolvedBy: "dave", timestamp: "2026-10-16T11:00:00.000Z", planDigest: DEV_PLAN, environment: "dev" }, loc);
  await persistReleasePlan({ digest: DEV_PLAN, work: ["W-001"] }, loc);
  const deploy = (env: string, gitSha: string, runId: string, timestamp: string, extra: Record<string, unknown>) =>
    appendReleaseRecord({ component: "api", env, digest: DEV_PLAN, gitSha, runId, timestamp, actor: "ci", ...extra }, loc);
  await deploy("prod", sha.c2, "run-1", "2026-10-16T10:40:00.000Z", { releaseDigest: v1.releaseDigest, approver: "bob", admission: { op: "release", gate: "prod-release", resolvedAt: "2026-10-16T10:30:00.000Z" } });
  await deploy("dev", sha.c3, "run-2", "2026-10-16T11:10:00.000Z", { approver: "dave", admission: { op: "api", gate: "dev-gate", resolvedAt: "2026-10-16T11:00:00.000Z" } });
  await deploy("staging", sha.c4, "run-3", "2026-10-16T12:40:00.000Z", { approver: "carol", admission: { op: "release", gate: "staging-release", resolvedAt: "2026-10-16T12:30:00.000Z" } });
}, 30_000);
afterAll(cleanScratch);

const intent = contract(intentSchema);
type Result = Exclude<IntentDocument, { error: unknown }>;

async function walk(region: string): Promise<Result> {
  const { doc } = await intentGraph({ cwd: root, region, kinds: ["work/work.kind.mjs", "decisions/decision.kind.mjs"].map((k) => join(root, k)) });
  intent.expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

describe("the why chain (#4023)", () => {
  test("a file region walks each commit to its work item, tag, release, gate and deploys, each link with its source", async () => {
    const doc = await walk("app/server.mjs");
    const trace = doc.trace!;
    expect(trace.reasons).toEqual([]);
    expect(trace.commits.map((c) => c.sha)).toEqual([sha.c3, sha.c2, sha.c1]);
    const [c3, c2] = trace.commits;

    // Who asked for it: the trailer links c2 to W-001; c3 only falls in its window.
    expect(c2.work).toEqual({ state: "linked", items: [{ id: "work:W-001", node: "record:work/W-001", source: { ref: sha.c2, field: "Chant-Record", value: "work:W-001" } }], problems: [] });
    expect(c3.work).toMatchObject({ state: "unlinked", items: [] });
    expect(c3.windowMatches).toEqual([{ id: "work:W-001", node: "record:work/W-001", source: { ref: "work/W-001-port.md", field: "window", value: "worked" } }]);

    // The ci tags.
    expect(c2.tag).toMatchObject({ state: "green", green: { tag: `ci/green/${sha.c2}`, source: { ref: `refs/tags/ci/green/${sha.c2}` } }, revoked: null });
    expect(c3.tag).toMatchObject({ state: "revoked", revoked: { tag: `ci/revoked/${sha.c3}` } });

    // The release cut from c2, and the first release that contains c3.
    expect(c2.releases).toEqual([{ release: v1.releaseDigest, link: "cut-from", source: { ref: `chant/lifecycle:_members/app/_releases/${v1.releaseDigest.replace(/:/g, "_")}.json`, field: "commit", value: sha.c2 } }]);
    expect(c3.releases).toEqual([expect.objectContaining({ release: v2.releaseDigest, link: "contains", source: expect.objectContaining({ value: sha.c4 }) })]);

    // The first deploy per environment that shipped each commit.
    expect(c2.deploys.map((d) => [d.env, d.link])).toEqual([["dev", "contains"], ["prod", "built-from"], ["staging", "contains"]]);
    expect(c3.deploys.map((d) => [d.env, d.link])).toEqual([["dev", "built-from"], ["staging", "contains"]]);

    // Who let it ship: the release gate's resolution, with resolver, channel, time and plan.
    const r1 = trace.releases.find((r) => r.releaseDigest === v1.releaseDigest)!;
    expect(r1).toMatchObject({ label: "v1", commit: sha.c2, tag: { state: "green" }, cuts: [{ label: "v1", actor: "alice", signed: false }] });
    expect(r1.gates).toEqual([
      expect.objectContaining({ op: "release", gate: "prod-release", environment: "prod", resolvedBy: "bob", channel: "cli", at: "2026-10-16T10:30:00.000Z", planDigest: PLAN, changeSet: null, source: { ref: "chant/lifecycle:_members/app/_gates/release.jsonl", field: "releaseDigest", value: v1.releaseDigest } }),
    ]);
    const prod = trace.deploys.find((d) => d.env === "prod")!;
    expect(r1.deploys).toEqual([prod.id]);
    expect(prod).toMatchObject({ release: v1.releaseDigest, releaseSource: { field: "releaseDigest" }, admittedBy: { gate: "prod-release", resolvedBy: "bob" }, source: { ref: "chant/lifecycle:_members/app/prod/releases.jsonl", field: "runId", value: "run-1" } });

    // A deploy with no releaseDigest joins its release through its release gate admission (#4043).
    const staging = trace.deploys.find((d) => d.env === "staging")!;
    expect(staging).toMatchObject({ release: v2.releaseDigest, releaseSource: { field: "admission", value: "staging-release@2026-10-16T12:30:00.000Z" }, admittedBy: { resolvedBy: "carol", channel: "mcp" } });
    expect(trace.releases.find((r) => r.releaseDigest === v2.releaseDigest)!.deploys).toEqual([staging.id]);

    // A plain deploy names no release, and its component gate and release plan (ws-055) are read back.
    const dev = trace.deploys.find((d) => d.env === "dev")!;
    expect(dev).toMatchObject({ release: null, admittedBy: { op: "api", gate: "dev-gate", resolvedBy: "dave", planDigest: DEV_PLAN }, plan: { document: { digest: DEV_PLAN, work: ["W-001"] }, source: { field: "digest" } } });

    expect(traceLines(trace)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^trace     ${sha.c2.slice(0, 8)} work work:W-001 \\(Chant-Record\\); in the window of work:W-001; green; released as v1; dev since`)),
        expect.stringMatching(/^release   v1 from .*green; cut by alice/),
        expect.stringMatching(/^  gate      release\/prod-release prod: bob on cli at 2026-10-16T10:30:00.000Z/),
        expect.stringMatching(/^deploy    dev api .* no release; admitted by api\/dev-gate dev: dave/),
      ]),
    );
  });

  test("a commit sha is a region: the chain of that one commit, from the files it changed", async () => {
    const doc = await walk(sha.c2.slice(0, 10));
    expect(doc.region).toBe(`region:commit:${sha.c2}`);
    expect(doc.nodes[0]).toMatchObject({ kind: "region", type: "commit", path: ".", commit: sha.c2, member: "app" });
    expect(doc.history.follows).toBe("commit");
    expect(doc.trace!.commits.map((c) => [c.sha, c.work?.state, c.tag.state, c.releases.map((r) => r.link)])).toEqual([[sha.c2, "linked", "green", ["cut-from"]]]);
    // W-001 constrains a file the commit changed, so the work node is there and the commit falls in its window.
    expect(doc.trace!.commits[0].windowMatches.map((w) => w.id)).toEqual(["work:W-001"]);
  });

  test("a commit no release was cut from is shipped by the first release that contains it", async () => {
    const doc = await walk("README.md");
    expect(doc.trace!.commits.map((c) => [c.sha, c.work?.state, c.tag.state, c.releases.map((r) => [r.release, r.link])])).toEqual([
      [sha.c4, "unlinked", "green", [[v2.releaseDigest, "cut-from"]]],
      [sha.c1, "unlinked", "none", [[v1.releaseDigest, "contains"]]],
    ]);
    expect(doc.trace!.commits[1].deploys.map((d) => [d.env, d.link])).toEqual([["dev", "contains"], ["prod", "contains"], ["staging", "contains"]]);
  });
});
