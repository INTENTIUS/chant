// The constraint record kind (#2771), data only: no imports, no code.
//
// chant workspace records --kind constraints/constraint.kind.mjs --current --json
//
// A rule that holds until it is withdrawn: narrower than a decision, with no
// options weighed, just the rule and what it governs. constrains carries the
// same grammar as a decision's, so a constraint's member:<name> and
// path:<path> entries become its links in chant workspace graph --intent the
// way a decision's do (#2549, #2651).
export const recordKind = {
  name: "constraint",
  location: { dir: ".", match: "^[a-z][a-z0-9]{0,15}-[0-9]{3,}-.+\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:intentius:chant:constraint:1", path: "constraint.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["proposed", "active", "withdrawn"],
  // Only withdrawn is final. The kind declares no approval ranks, so an
  // active constraint stays open to being amended, withdrawal included,
  // until it reaches this state.
  closedStates: ["withdrawn"],
  // Evidence entries with a path pin a workspace file by the hash of its bytes (#2549).
  pins: { field: "evidence" },
  // member:<name> and path:<path> entries are the record's links in workspace graph (#2549).
  constrains: { field: "constrains" },
  // records new --by and the MCP records-new tool's by name a proposal's
  // proposer here, apart from decided_by, which stays null until the
  // constraint is put in force (#2756).
  proposedBy: { field: "proposed_by" },
  // source is where the constraint came from, and says where its proposal
  // came from too: via, client, harness, model, session, turns and a
  // transcript pinned by hash (#2708).
  source: { field: "source" },
};
