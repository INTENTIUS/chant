// The decision record kind (#2555), data only: no imports, no code.
//
// chant workspace records --kind decisions/decision.kind.mjs --current --json
//
// A copy of docs/design/decisions/decision.kind.mjs in the chant repo, with
// decision.schema.json beside it, so a workspace made from this one reads its
// decisions without the chant repo. chant's test/reference-workspace.test.ts fails
// when this kind's data or the schema drifts from chant's.
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
};
