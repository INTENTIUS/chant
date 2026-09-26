// The lesson record kind (#2771), data only: no imports, no code.
//
// chant workspace records --kind lessons/lesson.kind.mjs --current --json
//
// What a box learned that a decision's prose never carries on its own: an
// incident, a surprising result, something that turned out not to work. A
// lesson names the situation, what was learned, and derived_from, the record
// or session it was drawn from. It is confirmed once a person checks it
// still holds, and a later, more precise lesson may supersede it.
export const recordKind = {
  name: "lesson",
  location: { dir: ".", match: "^[a-z][a-z0-9]{0,15}-[0-9]{3,}-.+\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:intentius:chant:lesson:1", path: "lesson.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["proposed", "confirmed", "superseded", "withdrawn"],
  // Sealed once confirmed (or superseded, on import). The kind declares no
  // approval ranks, so a supersedes link takes effect only from a new record
  // already in one of these states.
  closedStates: ["confirmed", "superseded"],
  supersedes: { field: "supersedes", key: "lesson" },
  // Evidence entries with a path pin a workspace file by the hash of its bytes (#2549).
  pins: { field: "evidence" },
  // records new --by and the MCP records-new tool's by name a proposal's
  // proposer here, apart from confirmed_by, which stays null until a person
  // confirms the lesson still holds (#2756).
  proposedBy: { field: "proposed_by" },
  // source is where the lesson came from, and says where its proposal came
  // from too: via, client, harness, model, session, turns and a transcript
  // pinned by hash (#2708).
  source: { field: "source" },
};
