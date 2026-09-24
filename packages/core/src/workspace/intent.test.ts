/**
 * The intent graph over one region (#2651), on a workspace built in a
 * throwaway git repository:
 *
 * - c1 declares two members, app and design, adds the screen spec
 *   `design/screens/home.json` and decision dec-001, which constrains
 *   `path:app/server.mjs` and pins the spec by hash.
 * - c2 adds `app/server.mjs` inside dec-001's window, with a `Unit: U-0001`
 *   trailer that the fixture plugin maps to a unit, a contract and evidence,
 *   and a `Made-By` trailer the plugin says claims authorship.
 * - c3 adds dec-002, which supersedes dec-001, pins the spec at the same hash
 *   and constrains `member:design` only.
 * - c4 edits `app/server.mjs` after that, with no decision covering it.
 *
 * Every node, edge and finding of the walk from `app/server.mjs` is asserted,
 * and variants cover the findings that fixture does not raise.
 */

import { readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, REPO, repo, writeFiles } from "./__fixtures__/contract-repo";
import { formatIntent } from "./intent-cli";
import { intentGraph, parseRegion, type IntentDocument, type IntentNode } from "./intent";
import intentSchema from "./intent.schema.json";
import { parseFrontMatter } from "./records";
import { sha256Hex } from "../content-digest";

const REF = join(REPO, "reference-workspace", "decisions");
const BASE = (() => {
  const fm = parseFrontMatter(readFileSync(join(REF, "ref-001-how-the-app-is-deployed.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
})();

const HOME = `${JSON.stringify({ route: "/", regions: ["header", "status"] }, null, 2)}\n`;
const HOME_SHA = sha256Hex(Buffer.from(HOME));

/** A decision record: ref-001 with its id, state and links replaced. JSON is YAML, so the front matter is JSON. */
function decision(id: string, fields: { state?: string; constrains: string[]; evidence?: unknown[]; supersedes?: string[] }): string {
  const data = {
    ...BASE,
    id,
    title: `Decision ${id}`,
    state: fields.state ?? "decided",
    supersedes: (fields.supersedes ?? []).map((d) => ({ decision: d })),
    evidence: fields.evidence ?? [],
    constrains: fields.constrains,
  };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

const pin = { title: "The home screen spec", path: "design/screens/home.json", sha256: HOME_SHA, as_of: "2026-09-24T12:00:00Z" };

/** The fixture plugin: a Unit trailer names a unit whose record names its contract. */
const PLUGIN = `
export function commitJoins(commit, context) {
  const id = commit.trailers["Unit"]?.[0];
  if (!id) return undefined;
  if (id === "U-BROKEN") throw new Error("no such unit");
  const unit = JSON.parse(context.read(\`units/\${id}.json\`));
  return {
    unit: { id, role: unit.role, outcome: unit.outcome },
    contract: { id: unit.contract, status: "closed" },
    evidence: [{ id: "E-1", ok: true }],
    authorship: commit.trailers["Made-By"] ? ["Made-By"] : [],
  };
}
`;

/** The same joins, as data only. */
const DATA_PLUGIN = `export const commitJoins = { trailers: { unit: "Unit" }, records: { unit: "units/{id}.json" }, authorship: ["Made-By"] };\n`;

const SERVER_1 = "// the app\nexport const status = 'Running.';\nexport const port = 8080;\n";
const SERVER_2 = "// the app\nexport const status = 'Up.';\nexport const port = 8080;\n";

let root: string;
const sha: Record<string, string> = {};
const KIND = "decisions/decision.kind.mjs";

function commit(message: string[]): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", ...message.flatMap((m) => ["-m", m]));
  return git(root, "rev-parse", "HEAD");
}

beforeAll(() => {
  root = repo({
    "chant.workspace.json": JSON.stringify(
      {
        name: "studio",
        schema: 1,
        members: [
          { name: "app", dir: "app", kind: "other", because: "a plain Node server" },
          { name: "design", dir: "design", kind: "other", because: "the design data member" },
        ],
      },
      null,
      2,
    ),
    "app/README.md": "The app.\n",
    "design/screens/home.json": HOME,
    "decisions/decision.kind.mjs": readFileSync(join(REF, "decision.kind.mjs"), "utf-8"),
    "decisions/decision.schema.json": readFileSync(join(REF, "decision.schema.json"), "utf-8"),
    "decisions/dec-001-server.md": decision("dec-001", { constrains: ["path:app/server.mjs"], evidence: [pin] }),
    "plugins/units.kind.mjs": PLUGIN,
    "plugins/units-data.kind.mjs": DATA_PLUGIN,
    "plugins/empty.kind.mjs": "export const nothing = 1;\n",
    "units/U-0001.json": JSON.stringify({ role: "implement", contract: "C-001", outcome: "done" }),
  });
  sha.c1 = commit(["decide the server"]);
  writeFiles(root, { "app/server.mjs": SERVER_1 });
  sha.c2 = commit(["add the server", "Unit: U-0001\nMade-By: agent"]);
  writeFiles(root, { "decisions/dec-002-design.md": decision("dec-002", { constrains: ["member:design"], evidence: [pin], supersedes: ["dec-001"] }) });
  sha.c3 = commit(["move the decision to the design member"]);
  writeFiles(root, { "app/server.mjs": SERVER_2 });
  sha.c4 = commit(["tweak the status line"]);
});
afterAll(cleanScratch);

const { expectValid } = contract(intentSchema);

type Result = Exclude<IntentDocument, { error: unknown }>;

async function walk(region: string, options: { kinds?: string[]; at?: string; cwd?: string } = {}): Promise<Result> {
  const { doc } = await intentGraph({ cwd: options.cwd ?? root, region, at: options.at, kinds: (options.kinds ?? [KIND, "plugins/units.kind.mjs"]).map((k) => join(root, k)) });
  expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

const node = (doc: Result, id: string): IntentNode | undefined => doc.nodes.find((n) => n.id === id);
const findings = (doc: Result) => doc.nodes.filter((n) => n.kind === "finding").map((n) => (n.kind === "finding" ? [n.code, n.concerns] : []));
const edges = (doc: Result) => doc.edges.map((e) => `${e.kind} ${e.from} -> ${e.to}${"granularity" in e ? ` (${e.granularity})` : ""}${"pinState" in e ? ` (${e.pinState})` : ""}`);

describe("the intent graph of app/server.mjs (#2651)", () => {
  test("lists every node, edge and finding", async () => {
    const doc = await walk("app/server.mjs");
    expect(doc).toMatchObject({ contract: 1, at: null, workspace: { name: "studio", root: "." }, region: "region:app/server.mjs" });
    expect(doc.history).toEqual({ rev: sha.c4, follows: "file", shallow: false });
    expect(doc.kinds).toEqual([
      { file: KIND, records: "decision", joins: null },
      { file: "plugins/units.kind.mjs", records: null, joins: "function" },
    ]);
    expect(doc.reasons).toEqual([]);

    expect(doc.nodes.map((n) => n.id)).toEqual([
      "region:app/server.mjs",
      "member:app",
      `commit:${sha.c4}`,
      `commit:${sha.c2}`,
      "unit:U-0001",
      "contract:C-001",
      "evidence:E-1",
      "record:decision/dec-001",
      "record:decision/dec-002",
      "artifact:design/screens/home.json",
      "finding:intent-commit-undecided:1",
      "finding:intent-commit-bare:1",
      "finding:intent-decision-superseded-live:1",
      "finding:intent-trailer-unverified:1",
    ]);

    expect(node(doc, "region:app/server.mjs")).toEqual({ id: "region:app/server.mjs", kind: "region", path: "app/server.mjs", lines: null, member: "app", at: null, type: "file", generated: false, node: null });
    expect(node(doc, "member:app")).toEqual({ id: "member:app", kind: "member", name: "app", dir: "app", memberKind: "other" });
    expect(node(doc, `commit:${sha.c2}`)).toMatchObject({
      kind: "commit",
      sha: sha.c2,
      subject: "add the server",
      author: { name: "t", email: "t@example.com" },
      trailers: { Unit: ["U-0001"], "Made-By": ["agent"] },
      pullRequest: null,
      signature: { level: "unattested" },
      lines: null,
    });
    expect(node(doc, `commit:${sha.c4}`)).toMatchObject({ subject: "tweak the status line", trailers: {} });
    expect(node(doc, "unit:U-0001")).toEqual({ id: "unit:U-0001", kind: "unit", ref: "U-0001", plugin: "plugins/units.kind.mjs", data: { role: "implement", outcome: "done" } });
    expect(node(doc, "contract:C-001")).toMatchObject({ kind: "contract", ref: "C-001", data: { status: "closed" } });
    expect(node(doc, "evidence:E-1")).toMatchObject({ kind: "evidence", ref: "E-1", data: { ok: true } });
    expect(node(doc, "record:decision/dec-001")).toMatchObject({
      kind: "decision",
      recordKind: "decision",
      record: "dec-001",
      path: "decisions/dec-001-server.md",
      state: "decided",
      closed: false,
      valid: true,
      decided_by: "lex00",
      reviews: { agree: 0, dissent: 0, abstain: 0, openConcerns: 0 },
      supersededBy: "dec-002",
      supersedes: [],
      constrains: [{ entry: "path:app/server.mjs", granularity: "path" }],
      provenance: { level: "unattested" },
    });
    expect(node(doc, "record:decision/dec-002")).toMatchObject({ record: "dec-002", supersededBy: null, supersedes: ["dec-001"], constrains: [] });
    expect(node(doc, "artifact:design/screens/home.json")).toEqual({
      id: "artifact:design/screens/home.json",
      kind: "artifact",
      path: "design/screens/home.json",
      anchor: null,
      pinnedSha256: HOME_SHA,
      currentSha256: HOME_SHA,
      // dec-002 pins the hash dec-001 pinned, and the spec has not changed since (#2549 asset-stale).
      pinState: "stale",
    });

    expect(edges(doc)).toEqual([
      `touched-by region:app/server.mjs -> commit:${sha.c4}`,
      `touched-by region:app/server.mjs -> commit:${sha.c2}`,
      `produced-by commit:${sha.c2} -> unit:U-0001`,
      "serves unit:U-0001 -> contract:C-001",
      "cites-evidence unit:U-0001 -> evidence:E-1",
      "constrains record:decision/dec-001 -> region:app/server.mjs (path)",
      "supersedes record:decision/dec-002 -> record:decision/dec-001",
      "pins record:decision/dec-001 -> artifact:design/screens/home.json (pinned)",
      "pins record:decision/dec-002 -> artifact:design/screens/home.json (stale)",
    ]);

    // c2 falls inside dec-001's window (from c1 until c3); c4 comes after it.
    expect(findings(doc)).toEqual([
      ["intent-commit-undecided", [`commit:${sha.c4}`, "region:app/server.mjs"]],
      ["intent-commit-bare", [`commit:${sha.c4}`]],
      ["intent-decision-superseded-live", ["region:app/server.mjs", "record:decision/dec-001"]],
      ["intent-trailer-unverified", [`commit:${sha.c2}`]],
    ]);
    expect(doc.summary).toEqual({ commits: 2, decisions: 2, artifacts: 1, findings: 4 });
  });

  test("the text walk runs region, decisions, artifacts, commits, findings, one line each", async () => {
    const text = formatIntent(await walk("app/server.mjs"));
    const lines = text.split("\n");
    expect(lines.map((l) => l.trim().split(/\s+/)[0])).toEqual(["region", "decision", "decision", "artifact", "commit", "commit", "unit", "contract", "evidence", "finding", "finding", "finding", "finding", "2"]);
    expect(lines[0]).toBe("region    app/server.mjs (file, member app) in the working tree");
    expect(lines[1]).toContain("dec-001 decided, superseded by dec-002");
    expect(lines[1]).toContain("path:app/server.mjs (path)");
    expect(lines[3]).toBe(`artifact  design/screens/home.json stale; pinned by dec-001 at ${HOME_SHA.slice(0, 8)} (pinned), dec-002 at ${HOME_SHA.slice(0, 8)} (stale); now ${HOME_SHA.slice(0, 8)}`);
    expect(lines[4]).toContain(`${sha.c4.slice(0, 8)} `);
    expect(lines.at(-1)).toBe("2 commits, 2 decisions, 1 artifacts, 4 findings");
  });

  test("a line range follows the lines with git log -L, and names the lines each commit changed", async () => {
    const doc = await walk("app/server.mjs:2");
    expect(doc.region).toBe("region:app/server.mjs:2");
    expect(doc.history.follows).toBe("line-range");
    expect(doc.edges.filter((e) => e.kind === "touched-by")).toEqual([
      { kind: "touched-by", from: "region:app/server.mjs:2", to: `commit:${sha.c4}`, lines: [{ start: 2, end: 2 }] },
      { kind: "touched-by", from: "region:app/server.mjs:2", to: `commit:${sha.c2}`, lines: [{ start: 2, end: 2 }] },
    ]);
  });

  test("the data form of commitJoins joins the same unit, with no plugin code", async () => {
    const doc = await walk("app/server.mjs", { kinds: [KIND, "plugins/units-data.kind.mjs"] });
    expect(doc.kinds[1]).toEqual({ file: "plugins/units-data.kind.mjs", records: null, joins: "data" });
    expect(node(doc, "unit:U-0001")).toEqual({ id: "unit:U-0001", kind: "unit", ref: "U-0001", plugin: "plugins/units-data.kind.mjs", data: { role: "implement", contract: "C-001", outcome: "done" } });
    expect(doc.edges).toContainEqual({ kind: "produced-by", from: `commit:${sha.c2}`, to: "unit:U-0001" });
    expect(findings(doc).map(([c]) => c)).toContain("intent-trailer-unverified");
  });

  test("without --kind there are no decisions, so no decision findings", async () => {
    const doc = await walk("app/server.mjs", { kinds: [] });
    expect(doc.nodes.map((n) => n.kind)).toEqual(["region", "member", "commit", "commit"]);
    expect(findings(doc)).toEqual([]);
  });

  test("--at reads the tree and the history at that commit", async () => {
    const doc = await walk("app/server.mjs", { at: sha.c2 });
    expect(doc.at).toBe(sha.c2);
    expect(doc.history.rev).toBe(sha.c2);
    expect(doc.nodes.filter((n) => n.kind === "commit").map((n) => n.id)).toEqual([`commit:${sha.c2}`]);
    expect(node(doc, "record:decision/dec-001")).toMatchObject({ supersededBy: null });
    expect(node(doc, "record:decision/dec-002")).toBeUndefined();
    // dec-001 is current and decided: the one commit is covered, and the decision is provisional.
    expect(findings(doc).map(([c]) => c)).toEqual(["intent-decision-provisional", "intent-trailer-unverified"]);
    expect(node(doc, "artifact:design/screens/home.json")).toMatchObject({ pinState: "pinned" });
  });
});

describe("findings the fixture does not raise (#2651)", () => {
  function withFile(path: string, text: string | null, fn: () => Promise<void>): () => Promise<void> {
    return async () => {
      const full = join(root, path);
      let before: string | null = null;
      try {
        before = readFileSync(full, "utf-8");
      } catch {
        before = null;
      }
      if (text === null) unlinkSync(full);
      else writeFileSync(full, text);
      try {
        await fn();
      } finally {
        if (before === null) rmSync(full, { force: true });
        else writeFileSync(full, before);
      }
    };
  }

  test(
    "a pinned artifact that changed is intent-pin-drifted, for each decision pinning it",
    withFile("design/screens/home.json", HOME.replace('"/"', '"/home"'), async () => {
      const doc = await walk("app/server.mjs");
      expect(node(doc, "artifact:design/screens/home.json")).toMatchObject({ pinState: "drifted", pinnedSha256: HOME_SHA });
      expect(findings(doc).filter(([c]) => c === "intent-pin-drifted")).toEqual([
        ["intent-pin-drifted", ["record:decision/dec-001", "artifact:design/screens/home.json"]],
        ["intent-pin-drifted", ["record:decision/dec-002", "artifact:design/screens/home.json"]],
      ]);
    }),
  );

  test(
    "a pinned artifact that is gone is intent-pin-missing",
    withFile("design/screens/home.json", null, async () => {
      const doc = await walk("app/server.mjs");
      expect(node(doc, "artifact:design/screens/home.json")).toMatchObject({ pinState: "missing", currentSha256: null });
      expect(findings(doc).filter(([c]) => c === "intent-pin-missing")).toHaveLength(2);
    }),
  );

  test(
    "an artifact only a superseded decision pins is intent-artifact-unpinned",
    withFile("decisions/dec-002-design.md", decision("dec-002", { constrains: ["member:design"], supersedes: ["dec-001"] }), async () => {
      const doc = await walk("app/server.mjs");
      expect(node(doc, "artifact:design/screens/home.json")).toMatchObject({ pinState: "unpinned", pinnedSha256: null });
      expect(findings(doc)).toContainEqual(["intent-artifact-unpinned", ["artifact:design/screens/home.json", "record:decision/dec-001"]]);
    }),
  );

  test("a directory no decision constrains is intent-region-unconstrained, and a path below it constrains its file", async () => {
    const doc = await walk("app");
    expect(doc.history.follows).toBe("directory");
    expect(doc.nodes.filter((n) => n.kind === "file").map((n) => n.id)).toEqual(["file:app/README.md", "file:app/server.mjs"]);
    expect(doc.edges).toContainEqual({ kind: "constrains", from: "record:decision/dec-001", to: "file:app/server.mjs", granularity: "path", entry: "path:app/server.mjs" });
    expect(findings(doc).map(([c]) => c)).toContain("intent-region-unconstrained");
    expect(node(doc, "record:decision/dec-001")).toMatchObject({ constrains: [] });
  });

  test(
    "a member-only, decided constraint is coarse and provisional; a lost path and an unhashed URL are reported",
    withFile(
      "decisions/dec-002-design.md",
      decision("dec-002", {
        constrains: ["member:design", "path:design/old.json"],
        evidence: [pin, { title: "A page", url: "https://example.com/page", as_of: "2026-09-24T12:00:00Z" }],
        supersedes: ["dec-001"],
      }),
      async () => {
        const doc = await walk("design/screens/home.json");
        expect(node(doc, "record:decision/dec-002")).toMatchObject({ constrains: [{ entry: "member:design", granularity: "member" }] });
        expect(doc.edges).toContainEqual({ kind: "cites-evidence", from: "record:decision/dec-002", to: "evidence:https://example.com/page" });
        expect(findings(doc).map(([c]) => c)).toEqual([
          "intent-commit-undecided",
          "intent-commit-bare",
          "intent-decision-provisional",
          "intent-constraint-coarse",
          "intent-constraint-lost",
          "intent-evidence-unpinned",
        ]);
      },
    ),
  );

  test(
    "a decision constraining an issue the region's commits name covers it at issue granularity",
    withFile("decisions/dec-003-issue.md", decision("dec-003", { constrains: ["acme/studio#12"] }), async () => {
      git(root, "remote", "add", "origin", "git@github.com:acme/studio.git");
      try {
        writeFiles(root, { "app/server.mjs": `${SERVER_2}// more\n` });
        const c5 = commit(["more (#12)"]);
        try {
          const doc = await walk("app/server.mjs");
          expect(node(doc, `commit:${c5}`)).toMatchObject({ pullRequest: 12 });
          expect(doc.edges).toContainEqual({ kind: "constrains", from: "record:decision/dec-003", to: "region:app/server.mjs", granularity: "issue", entry: "acme/studio#12" });
        } finally {
          git(root, "reset", "-q", "--hard", sha.c4);
        }
      } finally {
        git(root, "remote", "remove", "origin");
      }
    }),
  );
});

describe("reads that fail, and parts that can't be read (#2651)", () => {
  test("a path that does not exist, or a range past its end, is intent-region-invalid", async () => {
    for (const region of ["app/nope.mjs", "app/server.mjs:9", "app:1"]) {
      const { doc, failed } = await intentGraph({ cwd: root, region, kinds: [] });
      expectValid(doc);
      expect(failed).toBe(true);
      expect("error" in doc && doc.error.code).toBe("intent-region-invalid");
    }
  });

  test("a kind file with neither recordKind nor commitJoins is kind-invalid", async () => {
    const { doc } = await intentGraph({ cwd: root, region: "app/server.mjs", kinds: [join(root, "plugins/empty.kind.mjs")] });
    expectValid(doc);
    expect("error" in doc && doc.error.code).toBe("kind-invalid");
  });

  test("a plugin that throws is intent-plugin-failed, and the rest of the walk stands", async () => {
    writeFiles(root, { "app/server.mjs": `${SERVER_2}// broken\n` });
    commit(["break the unit", "Unit: U-BROKEN"]);
    try {
      const { doc, failed } = await intentGraph({ cwd: root, region: "app/server.mjs", kinds: [join(root, KIND), join(root, "plugins/units.kind.mjs")] });
      expectValid(doc);
      if ("error" in doc) throw new Error(doc.error.message);
      expect(failed).toBe(true);
      expect(doc.reasons).toEqual([{ code: "intent-plugin-failed", message: expect.stringContaining("no such unit") }]);
      expect(doc.summary.commits).toBe(3);
    } finally {
      git(root, "reset", "-q", "--hard", sha.c4);
    }
  });

  test("a shallow clone is intent-history-shallow", async () => {
    const shallow = join(root, "..", `${root.split("/").at(-1)}-shallow`);
    git(join(root, ".."), "clone", "-q", "--depth", "1", `file://${root}`, shallow);
    try {
      const { doc } = await intentGraph({ cwd: shallow, region: "app/server.mjs", kinds: [] });
      expectValid(doc);
      if ("error" in doc) throw new Error(doc.error.message);
      expect(doc.history.shallow).toBe(true);
      expect(doc.reasons.map((r) => r.code)).toEqual(["intent-history-shallow"]);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  test("a graph node id resolves to its sourceLoc", async () => {
    const { doc } = await intentGraph({
      cwd: root,
      region: "app/Server",
      kinds: [],
      resolveNode: async (_cwd, _at, member, id) => (member === "app" && id === "app/Server" ? { file: "server.mjs", line: 2 } : null),
    });
    expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(node(doc, doc.region)).toMatchObject({ path: "app/server.mjs", lines: { start: 2, end: 2 }, node: "app/Server" });
  });

  test("parseRegion reads path, path:line and path:start-end", () => {
    expect(parseRegion("a/b.ts")).toEqual({ path: "a/b.ts", lines: null });
    expect(parseRegion("a/b.ts:7")).toEqual({ path: "a/b.ts", lines: { start: 7, end: 7 } });
    expect(parseRegion("a/b.ts:3-9")).toEqual({ path: "a/b.ts", lines: { start: 3, end: 9 } });
    expect(parseRegion("a/b.ts:9-3")).toHaveProperty("error");
    expect(parseRegion("a/b.ts:0")).toHaveProperty("error");
  });
});
