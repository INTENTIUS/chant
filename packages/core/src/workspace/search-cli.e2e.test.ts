/**
 * `chant workspace search` (#4374): `chant search` in every member, under the
 * member's own chant, composed into one `search` document of the read
 * contract with the ids `chant workspace graph` gives the same nodes.
 *
 * The workspace here has two chant members, `east` and `west`, each a copy of
 * the reader conformance fixture's `delivery` member, and both run this
 * checkout's real chant. A member that runs a fake chant shows the reason
 * codes for a chant too old to print the document and for a read that fails.
 */

import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { writeSnapshot } from "../lifecycle/git";
import { cleanScratch, commitAll, contract, FAKE_GRAPH_CHANT, git, REPO, scratchDir } from "./__fixtures__/contract-repo";
import { CONFORMANCE_FIXTURE_DIR } from "./conformance";
import { workspaceGraph } from "./graph-cli";
import { readerBin, type Toolchain } from "./member-commands";
import { SEARCH_DOCUMENT_ERROR_CODES, SEARCH_MEMBER_REASON_CODES, SEARCH_OUTPUT_SCHEMA_ID } from "./search-contract";
import { workspaceSearch, type WorkspaceSearchDocument } from "./search-cli";
import schema from "./search.schema.json";

afterAll(cleanScratch);
// workspace graph's member cache, kept out of the user's cache directory.
process.env.CHANT_CACHE_DIR = scratchDir("chant-ws-search-cache-");

const TIMEOUT = 240_000;
const { expectValid } = contract(schema);

/** This checkout's chant, started the way the CLI starts it. */
const reader: Toolchain = {
  command: [process.execPath, "--import", pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href, join(REPO, "packages", "core", "src", "cli", "main.ts")],
  identity: realpathSync(readerBin()),
  source: "reader",
};

/** A git repository with `east` and `west`, two chant members, and whatever else `extra` declares, committed. */
function twoMembers(extra: { name: string; dir: string; kind: string }[] = []): string {
  const root = scratchDir("chant-ws-search-");
  for (const m of ["east", "west"]) cpSync(join(CONFORMANCE_FIXTURE_DIR, "delivery"), join(root, m), { recursive: true });
  mkdirSync(join(root, "node_modules", "@intentius"), { recursive: true });
  symlinkSync(resolve(REPO, "packages", "core"), join(root, "node_modules", "@intentius", "chant"), "dir");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(
    join(root, "chant.workspace.json"),
    JSON.stringify({ name: "two", schema: 1, members: [{ name: "east", dir: "east", kind: "chant" }, { name: "west", dir: "west", kind: "chant" }, ...extra] }, null, 2),
  );
  git(root, "init", "-q");
  commitAll(root, "two members");
  return root;
}

function result(doc: WorkspaceSearchDocument): Extract<WorkspaceSearchDocument, { matches: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  if (!("matches" in doc)) throw new Error("expected rows, got groups");
  return doc;
}

const search = (cwd: string, query: string, extra: Partial<Parameters<typeof workspaceSearch>[0]> = {}) => workspaceSearch({ cwd, query, reader, ...extra });

describe("the search schema (#4374)", () => {
  test("lists exactly the codes the code can return", () => {
    expect(schema.$id).toBe(SEARCH_OUTPUT_SCHEMA_ID);
    expect(schema.$defs.failure.properties.error.properties.code.enum).toEqual(SEARCH_DOCUMENT_ERROR_CODES);
    expect(schema.$defs.member.properties.reason.oneOf[1].properties!.code.enum).toEqual([...SEARCH_MEMBER_REASON_CODES]);
  });
});

describe("chant workspace search on two members", () => {
  test("ids are the <member>/<id> ids chant workspace graph prints for the same nodes", async () => {
    const root = twoMembers();
    const [found, graph] = await Promise.all([search(root, "kind:Fixture::Service"), workspaceGraph({ cwd: root, reader })]);
    const doc = result(found.doc);
    expectValid(doc);
    expect(found.failed).toBe(false);
    if ("error" in graph.doc) throw new Error(graph.doc.error.message);
    const graphIds = new Set(graph.doc.nodes.filter((n) => n.kind === "Fixture::Service").map((n) => n.id));
    expect(doc.matches.map((m) => m.id)).toEqual([...graphIds].sort());
    expect(doc.matches.map((m) => m.id)).toEqual(["east/appService", "west/appService"]);
    expect(doc.matches.map((m) => m.member)).toEqual(["east", "west"]);
    // Grouped by member, each searched alone, stamped by the graph cache's rule.
    expect(doc.members.map((m) => [m.name, m.status, m.alone, m.matches])).toEqual([
      ["east", "searched", true, ["east/appService"]],
      ["west", "searched", true, ["west/appService"]],
    ]);
    const graphStamps = Object.fromEntries(graph.doc.members.map((m) => [m.name, m.stamp]));
    for (const m of doc.members) expect(m.stamp, m.name).toBe(graphStamps[m.name]);
    expect(doc).toMatchObject({ contract: 1, workspace: { name: "two", root: "." }, at: null, source: { kind: "declared" } });
  }, TIMEOUT);

  test("--count-by kind adds the members' groups up, and validates", async () => {
    const root = twoMembers();
    const { doc } = await search(root, "", { flags: { countBy: "kind" } });
    expectValid(doc);
    expect(doc).toMatchObject({ countBy: "kind", total: 2 });
    if (!("groups" in doc)) throw new Error("no groups");
    const service = doc.groups.find((g) => g.group === "Fixture::Service");
    expect(service).toMatchObject({ count: 2 });
    // #4382: each group's ids, as `<member>/<id>`, one per member here.
    expect(service?.ids).toHaveLength(2);
    expect(service?.ids?.map((id) => id.split("/")[0]).sort()).toEqual(doc.members.map((m) => m.name).sort());
    expect(doc.members.map((m) => m.total)).toEqual([1, 1]);
  }, TIMEOUT);

  test("a refused query is a failure document with a code, before any member runs", async () => {
    const root = twoMembers();
    const { doc, failed } = await search(root, "effectiveIngress:tcp:22");
    expectValid(doc);
    expect(failed).toBe(true);
    expect(doc).toMatchObject({ error: { code: "query-invalid" } });
  }, TIMEOUT);
});

describe("two times: --at is the git revision, --snapshot the recorded estate", () => {
  test("--at <rev> searches the source at that commit; --snapshot latest replays the snapshot; the two are not confused", async () => {
    const root = twoMembers();
    const head = git(root, "rev-parse", "HEAD");
    // The working tree renames east's app; the commit still has the old name.
    const app = join(root, "east", "src", "app.ts");
    writeFileSync(app, readFileSync(app, "utf-8").replace("export const app =", "export const site ="));

    const now = result((await search(root, "kind:Fixture::Service", { members: ["east"] })).doc);
    expect(now.matches.map((m) => m.id)).toEqual(["east/siteService"]);
    expect(now.at).toBeNull();

    const then = result((await search(root, "kind:Fixture::Service", { members: ["east"], at: head })).doc);
    expectValid(then);
    expect(then.at).toBe(head);
    expect(then.source).toEqual({ kind: "declared" });
    expect(then.matches.map((m) => m.id)).toEqual(["east/appService"]);

    // A snapshot recorded for east only: east replays it, west has none and says so.
    await writeSnapshot(
      "dev",
      "fixture",
      JSON.stringify({ lexicon: "fixture", environment: "dev", commit: "c0ffee", timestamp: "2026-10-23T00:00:00.000Z", resources: { siteService: { type: "Fixture::Service", physicalId: "svc-east", status: "OK" } } }),
      { cwd: join(root, "east") },
    );
    const replayed = await search(root, "kind:Fixture::Service", { flags: { snapshot: "latest", env: "dev" } });
    const snap = result(replayed.doc);
    expectValid(snap);
    expect(snap.at).toBeNull();
    expect(snap.source).toEqual({ kind: "snapshot", env: "dev", snapshot: "latest" });
    expect(snap.matches).toEqual([expect.objectContaining({ id: "east/siteService", physicalId: "svc-east" })]);
    expect(snap.members[0]).toMatchObject({ name: "east", status: "searched", source: { kind: "snapshot", snapshot: "latest", commit: "c0ffee" } });
    expect(snap.members[1]).toMatchObject({ name: "west", status: "failed", reason: { code: "snapshot-unavailable" } });
    expect(replayed.failed).toBe(true);

    // --at given a snapshot ref names no commit, and the hint names --snapshot.
    const misused = await search(root, "kind:Fixture::Service", { at: "latest" });
    expectValid(misused.doc);
    expect(misused.doc).toMatchObject({ error: { code: "revision-unknown", hint: expect.stringContaining("--snapshot latest") } });
    // Both at once is refused.
    const both = await search(root, "kind:Fixture::Service", { at: head, flags: { snapshot: "latest", env: "dev" } });
    expectValid(both.doc);
    expect(both.doc).toMatchObject({ error: { code: "snapshot-at-revision" } });
  }, TIMEOUT);
});

describe("a member that can't be searched has a reason code, never zero matches", () => {
  test("a member whose chant is too old: member-chant-too-old", async () => {
    const root = twoMembers([{ name: "old", dir: "old", kind: "chant" }]);
    mkdirSync(join(root, "old", "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(root, "old", "chant.config.ts"), "export default {};\n");
    writeFileSync(join(root, "old", "ids.txt"), "Thing\n");
    writeFileSync(join(root, "old", "node_modules", ".bin", "chant"), FAKE_GRAPH_CHANT, { mode: 0o755 });
    const { doc, failed } = await search(root, "kind:Fixture::Service");
    expectValid(doc);
    expect(failed).toBe(true);
    const r = result(doc);
    expect(r.members.find((m) => m.name === "old")).toMatchObject({ status: "failed", chant: null, reason: { code: "member-chant-too-old" } });
    expect(r.members.find((m) => m.name === "old")).not.toHaveProperty("matches");
    expect(r.matches.map((m) => m.id)).toEqual(["east/appService", "west/appService"]);
  }, TIMEOUT);

  test("a member whose read fails: command-failed, and a missing directory: dir-missing", async () => {
    const root = twoMembers([{ name: "gone", dir: "gone", kind: "chant" }]);
    writeFileSync(join(root, "west", "chant.config.ts"), 'throw new Error("this config does not load");\n');
    const { doc, failed } = await search(root, "kind:Fixture::Service");
    expectValid(doc);
    expect(failed).toBe(true);
    const r = result(doc);
    expect(r.members.find((m) => m.name === "west")).toMatchObject({ status: "failed", reason: { code: "command-failed" } });
    expect(r.members.find((m) => m.name === "gone")).toMatchObject({ status: "failed", reason: { code: "dir-missing" } });
    expect(r.matches.map((m) => m.id)).toEqual(["east/appService"]);
  }, TIMEOUT);
});
