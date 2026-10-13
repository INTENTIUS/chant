/**
 * `chant workspace box publish` (#3165, ws-088): the box's declared
 * publisher run through chant, on workspaces in throwaway git repositories
 * whose publisher is a small script that records the request it got and
 * answers as a test tells it to through the environment.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, repo } from "./__fixtures__/contract-repo";
import { boxPublish, readAnswer, splitCommand, type BoxPublishDocument, type BoxPublishRequest } from "./box-publish";
import schema from "./box-publish.schema.json";
import statusSchema from "./status.schema.json";
import { workspaceStatus } from "./status";

afterAll(cleanScratch);

const { expectValid } = contract(schema);
const { expectValid: expectRequest } = contract({ $defs: schema.$defs, $ref: "#/$defs/request" });

/**
 * The publisher: writes the request it read to .publish-request.json, then
 * does what PUBLISH_MODE says. `good` commits a file with the apply record
 * for an item, or one Chant-Record per record for --records.
 */
const PUBLISHER = `
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const req = JSON.parse(readFileSync(0, "utf8"));
writeFileSync(".publish-request.json", JSON.stringify({ ...req, env: process.env.CHANT_PUBLISH_CONTRACT }));
const mode = process.env.PUBLISH_MODE ?? "good";
const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
const say = (o) => process.stdout.write("working...\\n" + JSON.stringify(o) + "\\n");
if (mode === "refuse") { process.stderr.write("W-1 is not built: there is no branch chant/work/W-1\\n"); process.exit(2); }
if (mode === "fail") { process.stderr.write("the push to acme/app failed\\n"); process.exit(1); }
if (mode === "silent") { process.stdout.write("done\\n"); process.exit(0); }
if (mode === "bad-answer") { say({ ok: true, commit: "abc" }); process.exit(0); }
if (mode === "sleep") { await new Promise((r) => setTimeout(r, 5000)); }
const records = [{ kind: "decision", id: "D-001", path: "decisions/D-001.md", title: "Keep it" }];
if (req.dryRun) { say({ ok: true, records: req.action === "records" ? records : [] }); process.exit(0); }
const tip = git("rev-parse", "HEAD");
writeFileSync("applied.txt", String(Date.now()));
git("add", "applied.txt");
const trailers = req.action === "item"
  ? [mode === "no-record" ? "" : "Chant-Record: work:" + req.item, "Chant-Applied-By: " + (mode === "wrong-by" ? "mallory" : req.by), "Chant-Applied-At: 2026-10-03T12:00:00Z", "Chant-Applied-Commit: " + tip].filter(Boolean)
  : mode === "no-record" ? [] : records.map((r) => "Chant-Record: " + r.kind + ":" + r.id);
git("commit", "-q", "-m", "publish", ...(trailers.length ? ["-m", trailers.join("\\n")] : []));
const commit = git("rev-parse", "HEAD");
say({ ok: true, commit, records: req.action === "records" ? records : [], pullRequest: { url: "https://github.com/acme/app/pull/7", number: 7, branch: "box/" + (req.item ?? "records"), base: "main" }, "x-studio": { box: "b1" } });
`;

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const PUBLISHER_CMD = `${quote(process.execPath)} publish.mjs`;

function declaration(box: Record<string, unknown> = { publisher: PUBLISHER_CMD }, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify(
    {
      name: "demo",
      schema: 1,
      members: [
        {
          name: "app",
          dir: "app",
          kind: "other",
          because: "a plain Node server",
          box: { services: [{ name: "web", cmd: "node server.mjs" }], factory: { builds: ["app"], publish: { repo: "acme/app", base: "main", branchPrefix: "box/" } }, ...box },
        },
        { name: "docs", dir: "docs", kind: "other", because: "prose" },
      ],
      ...extra,
    },
    null,
    2,
  )}\n`;
}

/** A workspace committed on main, the publisher beside the declaration. */
function workspace(decl = declaration()): string {
  const root = repo({ "chant.workspace.json": decl, "publish.mjs": PUBLISHER, "app/server.mjs": "export {};\n", "docs/README.md": "# Docs\n", ".gitignore": ".publish-request.json\n" }, true);
  git(root, "branch", "-M", "main");
  return root;
}

function run(root: string, req: Partial<BoxPublishRequest>, mode = "good"): BoxPublishDocument {
  const doc = boxPublish({ cwd: root, member: "app", env: { ...process.env, PUBLISH_MODE: mode }, ...req });
  expectValid(doc);
  return doc;
}

const ok = (doc: BoxPublishDocument) => {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
};
const code = (doc: BoxPublishDocument) => ("error" in doc ? doc.error.code : null);
const request = (root: string) => JSON.parse(readFileSync(join(root, ".publish-request.json"), "utf-8"));

describe("box publish runs the box's publisher and checks its apply record (#3165)", () => {
  test("an item: the request on stdin, the answer read back, and the apply record from the commit's trailers", () => {
    const root = workspace();
    const tip = git(root, "rev-parse", "HEAD");
    const doc = ok(run(root, { item: "W-1", by: "alice" }));
    expect(doc).toMatchObject({ member: "app", action: "item", item: "W-1", by: "alice", dryRun: false, publisher: PUBLISHER_CMD, records: [], pushed: null, local: null });
    expect(doc.commit).toBe(git(root, "rev-parse", "HEAD"));
    expect(doc.applied).toEqual({ by: "alice", at: "2026-10-03T12:00:00Z", commit: tip });
    expect(doc.pullRequest).toEqual({ url: "https://github.com/acme/app/pull/7", number: 7, branch: "box/W-1", base: "main", head: null });
    expect(doc.answer["x-studio"]).toEqual({ box: "b1" });
    const req = request(root);
    expect(req.env).toBe("1");
    delete req.env;
    expectRequest(req);
    expect(req).toMatchObject({ contract: 1, action: "item", member: "app", item: "W-1", by: "alice", head: null, dryRun: false });
    expect(req.factory.publish).toEqual({ forge: "github", repo: "acme/app", base: "main", branchPrefix: "box/", head: null });
  });

  test("--head reaches the publisher, and a malformed one is refused before it runs", () => {
    const root = workspace();
    ok(run(root, { item: "W-1", by: "alice", head: "alice/app" }));
    expect(request(root).head).toBe("alice/app");
    expect(code(run(root, { item: "W-1", by: "alice", head: "not a repo" }))).toBe("write-usage-invalid");
  });

  test("a commit without the apply record is publish-unrecorded, with the publisher's answer kept", () => {
    const root = workspace();
    const doc = run(root, { item: "W-1", by: "alice" }, "no-record");
    expect(code(doc)).toBe("publish-unrecorded");
    if (!("error" in doc)) throw new Error("expected an error");
    expect(doc.error.message).toContain("Chant-Record: <kind>:W-1");
    expect(doc.answer?.pullRequest).toBeTruthy();
    const wrong = run(root, { item: "W-1", by: "alice" }, "wrong-by");
    expect(code(wrong)).toBe("publish-unrecorded");
    if ("error" in wrong) expect(wrong.error.message).toContain("it names mallory");
  });

  test("records: a Chant-Record for each record sent, and --dry-run lists them without a commit", () => {
    const root = workspace();
    const listed = ok(run(root, { records: true, dryRun: true }));
    expect(listed).toMatchObject({ action: "records", item: null, by: null, dryRun: true, commit: null, applied: null });
    expect(listed.records).toEqual([{ kind: "decision", id: "D-001", path: "decisions/D-001.md", title: "Keep it" }]);
    const sent = ok(run(root, { records: true, by: "alice" }));
    expect(sent.commit).toBe(git(root, "rev-parse", "HEAD"));
    expect(sent.applied).toBeNull();
    expect(code(run(root, { records: true, by: "alice" }, "no-record"))).toBe("publish-unrecorded");
  });

  test("the publisher's exit says refused or failed, and a missing or malformed answer is publish-answer-invalid", () => {
    const root = workspace();
    const refused = run(root, { item: "W-1", by: "alice" }, "refuse");
    expect(code(refused)).toBe("publish-refused");
    if ("error" in refused) expect(refused.error.message).toBe("W-1 is not built: there is no branch chant/work/W-1");
    expect(code(run(root, { item: "W-1", by: "alice" }, "fail"))).toBe("publish-failed");
    expect(code(run(root, { item: "W-1", by: "alice" }, "silent"))).toBe("publish-answer-invalid");
    expect(code(run(root, { item: "W-1", by: "alice" }, "bad-answer"))).toBe("publish-answer-invalid");
  });

  test("a publisher that runs past the timeout is stopped and reported as publish-failed", () => {
    const root = workspace();
    const doc = run(root, { item: "W-1", by: "alice", timeoutMs: 300 }, "sleep");
    expect(code(doc)).toBe("publish-failed");
    if ("error" in doc) expect(doc.error.message).toContain("no answer within 300ms");
  });

  test("refusals before the publisher runs: no member, no publisher, no box, no item, no --by", () => {
    const root = workspace();
    expect(code(run(root, { member: "ghost", item: "W-1", by: "alice" }))).toBe("publish-member-unknown");
    expect(code(run(root, { member: "docs", item: "W-1", by: "alice" }))).toBe("publish-none");
    expect(code(run(root, { by: "alice" }))).toBe("write-usage-invalid");
    expect(code(run(root, { item: "W-1" }))).toBe("write-usage-invalid");
    expect(code(run(root, { item: "W-1", records: true, by: "alice" }))).toBe("write-usage-invalid");
    expect(code(run(workspace(declaration({})), { item: "W-1", by: "alice" }))).toBe("publish-none");
  });

  test("under identity.attribution identified, --by names a forge identity or a signer", () => {
    const root = workspace(declaration(undefined, { identity: { attribution: "identified" } }));
    expect(code(run(root, { item: "W-1", by: "alice" }))).toBe("principal-unidentified");
    expect(ok(run(root, { item: "W-1", by: "github:alice" })).applied?.by).toBe("github:alice");
  });

  test("status --json prints the publisher under the member's box, and null where none is named", async () => {
    const root = workspace();
    const status = await workspaceStatus({ env: "dev", cwd: root });
    contract(statusSchema).expectValid(status);
    const members = (status as { members: { name: string; box: { publisher?: string | null } | null }[] }).members;
    expect(members.find((m) => m.name === "app")?.box?.publisher).toBe(PUBLISHER_CMD);
    expect(members.find((m) => m.name === "docs")?.box).toBeNull();
  });
});

describe("the publisher's command and answer", () => {
  test("a command splits into words as a shell splits plain words, and nothing else", () => {
    expect(splitCommand("node box/ops/factory/publish.mjs")).toEqual(["node", "box/ops/factory/publish.mjs"]);
    expect(splitCommand(`'/opt/my node/bin/node' "a b" c\\ d $HOME ~/x`)).toEqual(["/opt/my node/bin/node", "a b", "c d", "$HOME", "~/x"]);
    expect(() => splitCommand("node 'open")).toThrow(/unclosed/);
    expect(() => splitCommand("   ")).toThrow(/empty/);
  });

  test("an answer is checked field by field", () => {
    expect(readAnswer({ ok: false })).toBe("it has no ok: true");
    expect(readAnswer({ ok: true })).toEqual({ commit: null, records: [], pullRequest: null, pushed: null, local: null });
    expect(readAnswer({ ok: true, pullRequest: { url: "http://x/1", number: 1, branch: "b", base: "main" } })).toMatch(/pullRequest/);
    expect(readAnswer({ ok: true, records: [{ kind: "work", id: "W-1" }] })).toMatch(/records\[0\]/);
    expect(readAnswer({ ok: true, pushed: { branch: "box/W-1", repo: "acme/app" }, local: "kept local" })).toMatchObject({ pushed: { branch: "box/W-1", repo: "acme/app" }, local: "kept local" });
  });
});
