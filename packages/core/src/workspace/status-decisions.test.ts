import { describe, expect, test } from "vitest";
import type { Declaration } from "./declaration";
import type { LoadedRecordKind, RecordEntry } from "./records";
import { memberDecisionsReader, type DecisionKindReader } from "./status-decisions";

const members = [
  { name: "root", dir: "." },
  { name: "api", dir: "services/api" },
  { name: "edge", dir: "services/api/edge" },
  { name: "web", dir: "web" },
];

function declaration(kinds: string[]): Declaration {
  return {
    records: kinds.map((path) => ({ kind: path, path, name: null, member: null, pointer: "/records/0" })),
    members: members.map((m) => ({ ...m, records: [] })),
  } as unknown as Declaration;
}

function kind(name: string, extra: Record<string, unknown> = {}): LoadedRecordKind {
  return { kind: { name, constrains: { field: "constrains" }, closedStates: ["accepted"], ...extra } } as unknown as LoadedRecordKind;
}

function record(id: string, constrains: string[], state = "proposed", supersededBy: string | null = null): RecordEntry {
  return { id, path: `decisions/${id}.md`, state, supersededBy, data: { constrains } } as unknown as RecordEntry;
}

function reader(kinds: Record<string, { loaded: LoadedRecordKind; records: RecordEntry[]; workspaceRoot?: string } | Error>): DecisionKindReader {
  return async (file) => {
    const k = Object.entries(kinds).find(([path]) => file.endsWith(path))?.[1];
    if (!k) throw new Error(`no kind ${file}`);
    if (k instanceof Error) throw k;
    return { loaded: k.loaded, top: undefined, workspaceRoot: k.workspaceRoot ?? ".", records: k.records };
  };
}

describe("the decisions covering a gate's member (#3616)", () => {
  test("path above, member and path inside, ranked as why ranks them", async () => {
    const read = reader({
      "decision.kind.mjs": {
        loaded: kind("decision"),
        records: [
          record("d-inside", ["path:services/api/src/handler.ts"]),
          record("d-member", ["member:api"]),
          record("d-services", ["path:services"]),
          record("d-api", ["path:services/api"], "accepted"),
          record("d-api-open", ["path:services/api"]),
          record("d-web", ["path:web", "member:web"]),
          record("d-edge-only", ["path:services/api/edge/x.ts"]),
        ],
      },
    });
    const covering = await memberDecisionsReader(declaration(["decision.kind.mjs"]), "/repo", "", read);
    // Closed before open at one path; a longer path before a shorter one; then member; then inside.
    expect(covering(members[1])).toEqual(["decision/d-api", "decision/d-api-open", "decision/d-services", "decision/d-member", "decision/d-inside"]);
    // A path inside a nested member is the nested member's, and the path above covers it too.
    expect(covering(members[2])).toEqual(["decision/d-api", "decision/d-api-open", "decision/d-services", "decision/d-edge-only"]);
    expect(covering(members[3])).toEqual(["decision/d-web"]);
    // The root member holds services itself, and no path another member holds.
    expect(covering(members[0])).toEqual(["decision/d-services"]);
  });

  test("a superseded covering decision stands for the current one at the end of its chain", async () => {
    const read = reader({
      "decision.kind.mjs": {
        loaded: kind("decision"),
        records: [record("old", ["member:web"], "superseded", "mid"), record("mid", [], "superseded", "new"), record("new", ["path:elsewhere"], "accepted"), record("gone", ["member:web"], "superseded", "missing")],
      },
    });
    const covering = await memberDecisionsReader(declaration(["decision.kind.mjs"]), "/repo", "", read);
    expect(covering(members[3])).toEqual(["decision/new"]);
  });

  test("path entries resolve from the kind's workspace root, and a member's dir from the workspace's", async () => {
    const read = reader({
      "decision.kind.mjs": { loaded: kind("decision"), workspaceRoot: "ws", records: [record("d", ["path:web"])] },
    });
    const covering = await memberDecisionsReader(declaration(["decision.kind.mjs"]), "/repo/ws", "ws", read);
    expect(covering(members[3])).toEqual(["decision/d"]);
    expect(covering(members[1])).toEqual([]);
  });

  test("work kinds, kinds without constrains and unreadable kinds cover nothing", async () => {
    const read = reader({
      "work.kind.mjs": { loaded: kind("work", { work: {} }), records: [record("w", ["member:web"])] },
      "note.kind.mjs": { loaded: kind("note", { constrains: undefined }), records: [record("n", ["member:web"])] },
      "broken.kind.mjs": new Error("kind-unreadable"),
      "adr.kind.mjs": { loaded: kind("adr"), records: [record("a", ["member:web"])] },
    });
    const covering = await memberDecisionsReader(declaration(["work.kind.mjs", "note.kind.mjs", "broken.kind.mjs", "adr.kind.mjs"]), "/repo", "", read);
    expect(covering(members[3])).toEqual(["adr/a"]);
  });

  test("no declared record kind reads nothing", async () => {
    const covering = await memberDecisionsReader(declaration([]), "/repo", "", async () => {
      throw new Error("not read");
    });
    expect(covering(members[3])).toEqual([]);
  });
});
