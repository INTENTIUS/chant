/**
 * Asset pins and record links (#2549): a decision's evidence may pin a
 * workspace file by path and hash; `records` checks the pin in the tree it
 * reads and reports drift as a warning that leaves the record valid; `graph
 * --kind` emits `asset` and `constrains` rows; `check --kind` reports drift
 * as WSP111.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, commitAll, contract, declaration, repo, REPO } from "./__fixtures__/contract-repo";
import { runChecks } from "./lineage-check";
import { constraintCovers, isWorkspacePath, memberHolding, WORKSPACE_PATH_PATTERN } from "./record-assets";
import { pinFile, queryRecords, type RecordsDocument } from "./records-cli";
import { parseFrontMatter, RECORD_WARNING_CODES } from "./records";
import { WORK_WARNING_CODES } from "./work";
import { workspaceGraph } from "./graph-cli";
import graphSchema from "./graph.schema.json";
import recordsSchema from "./records.schema.json";

afterAll(cleanScratch);

const DECISIONS = join(REPO, "docs", "design", "decisions");
const SAMPLE = readFileSync(join(DECISIONS, "ws-003-seal-scope.md"), "utf-8");
const KIND = readFileSync(join(DECISIONS, "decision.kind.mjs"), "utf-8");
const SCHEMA = readFileSync(join(DECISIONS, "decision.schema.json"), "utf-8");
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** ws-003 with its id replaced, and extra evidence and constrains entries. */
function decision(id: string, evidence: string[], constrains: string[] = [], state = "decided", supersedes: string[] = []): string {
  let text = SAMPLE.replace(/^id: .*$/m, `id: "${id}"`).replace(/^state: .*$/m, `state: "${state}"`);
  text = text.replace(/^evidence:\n/m, `evidence:\n${evidence.join("")}`);
  text = text.replace(/^constrains:(?: \[\])?\n/m, `constrains:\n${constrains.map((c) => `  - "${c}"\n`).join("")}`);
  const links = supersedes.length === 0 ? "supersedes: []" : `supersedes:\n${supersedes.map((d) => `  - decision: "${d}"`).join("\n")}`;
  return text.replace(/^supersedes:(?: \[\])?\n(?:  .*\n)*/m, `${links}\n`);
}

const pin = (path: string, hash: string) => `  - title: "the spec"\n    path: "${path}"\n    sha256: "${hash}"\n`;

const SPEC = '{ "screen": "home" }\n';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);

/** A git repository holding a workspace at `ws/`, whose decisions pin files in its `design` member. */
function workspace(extra: Record<string, string> = {}): string {
  const root = repo({
    "ws/chant.workspace.json": declaration([
      { name: "app", dir: "app", kind: "other", because: "an app" },
      { name: "design", dir: "design", kind: "other", because: "design data" },
    ]),
    "ws/app/src/server.mjs": "export {};\n",
    "ws/design/screens/home.json": SPEC,
    "ws/decisions/decision.kind.mjs": KIND,
    "ws/decisions/decision.schema.json": SCHEMA,
    "ws/decisions/ws-101-spec.md": decision("ws-101", [pin("design/screens/home.json", sha(SPEC))], ["member:design", "path:app/src", "path:app/nope", "member:ghost"]),
    ...extra,
  });
  writeFileSync(join(root, "ws", "design", "screens", "home.png"), PNG);
  return root;
}

function records(doc: RecordsDocument) {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

describe("the path grammar", () => {
  test("the decision schema holds the same pattern for evidence and constrains", () => {
    const schema = JSON.parse(SCHEMA) as { definitions: { workspacePath: { pattern: string } }; properties: { constrains: { items: { pattern: string } } } };
    expect(schema.definitions.workspacePath.pattern).toBe(`^${WORKSPACE_PATH_PATTERN}$`);
    expect(schema.properties.constrains.items.pattern).toContain(`|path:${WORKSPACE_PATH_PATTERN})$`);
  });

  test.each([
    ["design/screens/home.json", true],
    [".github/workflows/ci.yml", true],
    ["app", true],
    ["/etc/passwd", false],
    ["../outside", false],
    ["a/../b", false],
    ["./a", false],
    ["a//b", false],
    ["a/", false],
    ["a\\b", false],
    ["", false],
  ])("%s is a workspace path: %s", (path, ok) => {
    expect(isWorkspacePath(path)).toBe(ok);
  });

  test("the schema takes a path pin with a hash, refuses one without, and keeps url entries as they were", () => {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(SCHEMA) as object);
    const base = { title: "t" };
    const withEvidence = (evidence: unknown[]) => {
      const fm = parseFrontMatter(decision("ws-101", []));
      if (!fm.ok) throw new Error(fm.message);
      return { ...fm.value, evidence };
    };
    expect(validate(withEvidence([{ ...base, path: "design/a.json", sha256: sha("x") }]))).toBe(true);
    expect(validate(withEvidence([{ ...base, url: "https://example.com", sha256: null }]))).toBe(true);
    expect(validate(withEvidence([{ ...base, path: "design/a.json" }]))).toBe(false);
    expect(validate(withEvidence([{ ...base, path: "design/a.json", sha256: null }]))).toBe(false);
    expect(validate(withEvidence([{ ...base, path: "../a.json", sha256: sha("x") }]))).toBe(false);
    expect(validate(withEvidence([{ ...base, path: "a.json", url: "https://example.com", sha256: sha("x") }]))).toBe(false);
    expect(validate({ ...withEvidence([{ ...base, url: "https://example.com" }]), constrains: ["path:app/src", "member:app", "INTENTIUS/chant#1"] })).toBe(true);
    expect(validate({ ...withEvidence([{ ...base, url: "https://example.com" }]), constrains: ["path:../x"] })).toBe(false);
  });

  test("a path belongs to the deepest member holding it, and a path: constraint covers what is below it", () => {
    const members = [
      { name: "root", dir: "." },
      { name: "app", dir: "app" },
      { name: "api", dir: "app/api" },
    ];
    expect(memberHolding("app/api/x.ts", members)).toBe("api");
    expect(memberHolding("app/x.ts", members)).toBe("app");
    expect(memberHolding("apps/x.ts", members)).toBe("root");
    expect(memberHolding("x", [{ name: "app", dir: "app" }])).toBeNull();
    expect(constraintCovers("app", "app/src/server.mjs")).toBe(true);
    expect(constraintCovers("app", "apps/x")).toBe(false);
  });
});

describe("chant workspace records checks each pin", () => {
  const { expectValid } = contract(recordsSchema);

  test("a pin that matches is pinned, resolved from the workspace holding the kind", async () => {
    const root = workspace();
    const doc = records(await queryRecords({ kind: "ws/decisions/decision.kind.mjs", cwd: root }));
    expectValid(doc);
    expect(doc.workspaceRoot).toBe("ws");
    const [r] = doc.records;
    expect(r.valid).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.assets).toEqual([{ path: "design/screens/home.json", sha256: sha(SPEC), actual: sha(SPEC), state: "pinned" }]);
  });

  test("an edited file is asset-drift and a missing one asset-missing; the record stays valid and current", async () => {
    const root = workspace({
      "ws/decisions/ws-102-gone.md": decision("ws-102", [pin("design/screens/gone.json", sha("x"))]),
    });
    writeFileSync(join(root, "ws", "design", "screens", "home.json"), '{ "screen": "home", "edited": true }\n');
    const doc = records(await queryRecords({ kind: "ws/decisions/decision.kind.mjs", current: true, cwd: root }));
    expectValid(doc);
    expect(doc.records.map((r) => [r.id, r.valid, r.warnings.map((w) => w.code), r.assets.map((a) => a.state)])).toEqual([
      ["ws-101", true, ["asset-drift"], ["drifted"]],
      ["ws-102", true, ["asset-missing"], ["missing"]],
    ]);
    expect(doc.summary.invalid).toBe(0);
    expect(doc.records[1].assets[0].actual).toBeNull();
  });

  test("the bytes are hashed, not the text", async () => {
    const root = workspace({ "ws/decisions/ws-103-png.md": decision("ws-103", [pin("design/screens/home.png", sha(PNG))]) });
    const doc = records(await queryRecords({ kind: "ws/decisions/decision.kind.mjs", cwd: root }));
    expect(doc.records.find((r) => r.id === "ws-103")!.assets[0].state).toBe("pinned");
  });

  test("--at checks the pin against the file as committed at that revision", async () => {
    const root = workspace();
    const first = commitAll(root, "one");
    writeFileSync(join(root, "ws", "design", "screens", "home.json"), "{}\n");
    const second = commitAll(root, "two");
    const at = async (rev: string) => records(await queryRecords({ kind: "ws/decisions/decision.kind.mjs", at: rev, cwd: root })).records[0].assets[0].state;
    expect(await at(first)).toBe("pinned");
    expect(await at(second)).toBe("drifted");
  });

  test("the schema lists exactly the warning codes", () => {
    // A work kind's records carry the work warnings too, except work-done-gap-open, which only graph --intent raises (#2683).
    expect(recordsSchema.$defs.warning.properties.code.enum).toEqual([...RECORD_WARNING_CODES, ...WORK_WARNING_CODES.filter((c) => c !== "work-done-gap-open")]);
  });

  test("records pin <path> prints the entry's path from the workspace root and the file's hash", () => {
    const root = workspace();
    expect(pinFile("screens/home.json", join(root, "ws", "design"))).toEqual({ path: "design/screens/home.json", sha256: sha(SPEC) });
    expect(pinFile("ws/design/screens/home.png", root)).toEqual({ path: "design/screens/home.png", sha256: sha(PNG) });
    expect(pinFile("design", join(root, "ws"))).toEqual({ error: "design is not a file" });
  });
});

describe("chant workspace graph --kind", () => {
  const { expectValid } = contract(graphSchema);

  test("emits an asset row per pin and a constrains row per member or path, and the document validates", async () => {
    const root = workspace({ "ws/decisions/ws-104-old.md": decision("ws-104", [pin("design/screens/home.json", sha("old"))]) });
    writeFileSync(join(root, "ws", "decisions", "ws-105-new.md"), decision("ws-105", [], [], "ratified", ["ws-104"]));
    const { doc, failed } = await workspaceGraph({ cwd: join(root, "ws"), kind: join(root, "ws", "decisions", "decision.kind.mjs") });
    expect(failed).toBe(false);
    expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.records.map((r) => [r.kind, r.id, r.supersededBy])).toEqual([
      ["decision", "ws-101", null],
      ["decision", "ws-104", "ws-105"],
      ["decision", "ws-105", null],
    ]);
    const rows = doc.links.map((r) => ("record" in r ? [r.kind, r.record, r.target, r.member, r.status] : []));
    // ws-104 is superseded, so its drifted pin is no row.
    expect(rows).toEqual([
      ["asset", "ws-101", "design/screens/home.json", "design", "pinned"],
      ["constrains", "ws-101", "member:design", "design", "resolved"],
      ["constrains", "ws-101", "path:app/src", "app", "resolved"],
      ["constrains", "ws-101", "path:app/nope", "app", "missing"],
      ["constrains", "ws-101", "member:ghost", null, "missing"],
    ]);
  });

  test("a kind that can't be read fails the command and leaves the records empty", async () => {
    const root = workspace();
    const errors: string[] = [];
    const { doc, failed } = await workspaceGraph({ cwd: join(root, "ws"), kind: join(root, "nope.mjs"), onStderr: (t) => errors.push(t) });
    expect(failed).toBe(true);
    expectValid(doc);
    expect(errors.join("")).toContain("kind-unreadable");
  });
});

describe("chant workspace check --kind", () => {
  test("reports a drifted pin as a WSP111 warning on the record, and passes", async () => {
    const root = workspace();
    writeFileSync(join(root, "ws", "design", "screens", "home.json"), "{}\n");
    const doc = await runChecks(join(root, "ws"), undefined, { kind: "decisions/decision.kind.mjs" });
    if ("error" in doc) throw new Error(doc.error.message);
    const found = doc.declaration!.diagnostics.filter((d) => d.ruleId.startsWith("WSP11"));
    expect(found.map((d) => [d.ruleId, d.severity, d.file])).toEqual([["WSP111", "warning", "decisions/ws-101-spec.md"]]);
    expect(doc.ok).toBe(true);
  });

  test("without --kind no record is read; an unreadable kind is a WSP114 error", async () => {
    const root = workspace();
    writeFileSync(join(root, "ws", "design", "screens", "home.json"), "{}\n");
    const plain = await runChecks(join(root, "ws"));
    if ("error" in plain) throw new Error(plain.error.message);
    expect(plain.declaration!.diagnostics.some((d) => d.ruleId.startsWith("WSP11"))).toBe(false);
    const bad = await runChecks(join(root, "ws"), undefined, { kind: "decisions/nope.mjs" });
    if ("error" in bad) throw new Error(bad.error.message);
    expect(bad.declaration!.diagnostics.map((d) => d.ruleId)).toContain("WSP114");
    expect(bad.ok).toBe(false);
  });
});

describe("asset-stale: the decision changed and the artifact did not follow", () => {
  /** Commit everything in `root` at `seconds` since the epoch, so commit times are ordered. */
  const commitAt = (root: string, seconds: number) => {
    const env = { ...process.env, GIT_AUTHOR_DATE: `@${seconds} +0000`, GIT_COMMITTER_DATE: `@${seconds} +0000`, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    execFileSync("git", ["add", "-A"], { cwd: root, env });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", String(seconds)], { cwd: root, env });
  };
  const kind = "ws/decisions/decision.kind.mjs";
  const superseding = (hash: string) => decision("ws-106", [pin("design/screens/home.json", hash)], [], "decided", ["ws-101"]);

  test("a superseding record that pins the old hash of an unchanged file is stale; drift and missing stay apart", async () => {
    const root = workspace({
      // ws-107 supersedes ws-102 and pins a file that is gone; ws-108 supersedes ws-103 and pins a file that changed.
      "ws/decisions/ws-102-gone.md": decision("ws-102", [pin("design/screens/gone.json", sha("x"))]),
      "ws/decisions/ws-103-other.md": decision("ws-103", [pin("design/screens/other.json", sha("one\n"))]),
      "ws/design/screens/other.json": "one\n",
    });
    commitAt(root, 1_700_000_000);
    writeFileSync(join(root, "ws", "decisions", "ws-106-new.md"), superseding(sha(SPEC)));
    writeFileSync(join(root, "ws", "decisions", "ws-107-gone.md"), decision("ws-107", [pin("design/screens/gone.json", sha("x"))], [], "decided", ["ws-102"]));
    writeFileSync(join(root, "ws", "decisions", "ws-108-other.md"), decision("ws-108", [pin("design/screens/other.json", sha("one\n"))], [], "decided", ["ws-103"]));
    writeFileSync(join(root, "ws", "design", "screens", "other.json"), "two\n");
    commitAt(root, 1_700_000_100);

    const doc = records(await queryRecords({ kind, current: true, cwd: root }));
    contract(recordsSchema).expectValid(doc);
    expect(doc.records.map((r) => [r.id, r.valid, r.assets.map((a) => a.state), r.warnings.map((w) => w.code)])).toEqual([
      ["ws-106", true, ["stale"], ["asset-stale"]],
      ["ws-107", true, ["missing"], ["asset-missing"]],
      ["ws-108", true, ["drifted"], ["asset-drift"]],
    ]);

    // The same read at the revision agrees.
    const at = records(await queryRecords({ kind, current: true, at: "HEAD", cwd: root }));
    expect(at.records[0].assets[0].state).toBe("stale");

    const { doc: graph } = await workspaceGraph({ cwd: join(root, "ws"), kind: join(root, kind) });
    contract(graphSchema).expectValid(graph);
    if ("error" in graph) throw new Error(graph.error.message);
    expect(graph.links.flatMap((r) => ("record" in r && r.kind === "asset" ? [[r.record, r.status]] : []))).toEqual([
      ["ws-106", "stale"],
      ["ws-107", "missing"],
      ["ws-108", "drifted"],
    ]);

    const check = await runChecks(join(root, "ws"), undefined, { kind: "decisions/decision.kind.mjs" });
    if ("error" in check) throw new Error(check.error.message);
    expect(check.declaration!.diagnostics.filter((d) => d.ruleId.startsWith("WSP11")).map((d) => d.ruleId).sort()).toEqual(["WSP111", "WSP112", "WSP113"]);
  });

  test("re-pinning the new version of the file clears it", async () => {
    const root = workspace();
    commitAt(root, 1_700_000_000);
    const next = '{ "screen": "home", "v": 2 }\n';
    writeFileSync(join(root, "ws", "design", "screens", "home.json"), next);
    writeFileSync(join(root, "ws", "decisions", "ws-106-new.md"), superseding(sha(next)));
    const doc = records(await queryRecords({ kind, current: true, cwd: root }));
    expect(doc.records.map((r) => [r.id, r.assets.map((a) => a.state), r.warnings])).toEqual([["ws-106", ["pinned"], []]]);
  });

  test("a file committed again after the record was recorded is not stale, even at the same hash", async () => {
    const root = workspace();
    commitAt(root, 1_700_000_000);
    writeFileSync(join(root, "ws", "decisions", "ws-106-new.md"), superseding(sha(SPEC)));
    commitAt(root, 1_700_000_100);
    const spec = join(root, "ws", "design", "screens", "home.json");
    rmSync(spec);
    commitAt(root, 1_700_000_200);
    writeFileSync(spec, SPEC);
    commitAt(root, 1_700_000_300);
    const doc = records(await queryRecords({ kind, current: true, cwd: root }));
    expect(doc.records[0].assets[0].state).toBe("pinned");
    // At the revision where the record was recorded, the file had not moved since ws-101 pinned it.
    const log = execFileSync("git", ["log", "--format=%H"], { cwd: root, encoding: "utf-8" }).trim().split("\n");
    const at = records(await queryRecords({ kind, current: true, at: log[2], cwd: root }));
    expect(at.records[0].assets[0].state).toBe("stale");
  });
});
