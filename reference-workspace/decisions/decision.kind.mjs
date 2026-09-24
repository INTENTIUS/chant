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
  // Sealed once reached (#2555). A supersedes link takes effect only from one.
  closedStates: ["ratified", "superseded"],
  supersedes: { field: "supersedes", key: "decision" },
};
