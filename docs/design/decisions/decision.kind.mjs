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
  // Sealed once reached (#2555). A supersedes link takes effect only from one.
  closedStates: ["ratified", "superseded"],
  supersedes: { field: "supersedes", key: "decision" },
};
