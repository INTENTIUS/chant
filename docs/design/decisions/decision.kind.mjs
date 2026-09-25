// The decision record kind (#2555), data only: no imports, no code.
//
// chant workspace records --kind docs/design/decisions/decision.kind.mjs --current --json
//
// Paths are relative to this file. The kind lives here, beside its schema,
// until the development-model plugin takes it over. Core ships no decision kind.
export const recordKind = {
  name: "decision",
  location: { dir: ".", match: "^[a-z][a-z0-9]{0,15}-[0-9]{3,}-.+\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:intentius:chant:decision:1", path: "decision.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["proposed", "decided", "ratified", "superseded", "withdrawn"],
  // Sealed once reached (#2555).
  closedStates: ["ratified", "superseded"],
  supersedes: { field: "supersedes", key: "decision" },
  // A supersedes link takes effect under an equal or stricter approval rule
  // (#2524 D4): from a record ranked above 0 and at least as high as the one it
  // names. A decided record supersedes a decided or proposed one, a ratified
  // record supersedes any, and a proposed or withdrawn record none.
  approval: { proposed: 0, withdrawn: 0, decided: 1, ratified: 2, superseded: 2 },
  // Evidence entries with a path pin a workspace file by the hash of its bytes (#2549).
  pins: { field: "evidence" },
  // member:<name> and path:<path> entries are the record's links in workspace graph (#2549).
  constrains: { field: "constrains" },
  // Verdicts, and the field naming the decider, for each record's digest and
  // quorum (#2671, #2672).
  reviews: { field: "reviews", decider: "decided_by" },
  // source is where a decision came from, and says where its proposal came
  // from too: via, client, harness, model, session, turns and a transcript
  // pinned by hash (#2708).
  source: { field: "source" },
};
