// The preference record kind (#2771), data only: no imports, no code.
//
// chant workspace records --kind preferences/preference.kind.mjs --current --json
//
// A default a person or team chose, weaker than a constraint: nothing
// governs anything by it, and a decision may override it without
// superseding it. It shares the constraint kind's lifecycle, proposed, then
// active until withdrawn, so a workspace can tell "we always do it this way"
// apart from a rule that holds.
export const recordKind = {
  name: "preference",
  location: { dir: ".", match: "^[a-z][a-z0-9]{0,15}-[0-9]{3,}-.+\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:intentius:chant:preference:1", path: "preference.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["proposed", "active", "withdrawn"],
  // Only withdrawn is final. The kind declares no approval ranks, so an
  // active preference stays open to being amended, withdrawal included,
  // until it reaches this state.
  closedStates: ["withdrawn"],
  // Evidence entries with a path pin a workspace file by the hash of its bytes (#2549).
  pins: { field: "evidence" },
  // records new --by and the MCP records-new tool's by name a proposal's
  // proposer here, apart from chosen_by, which stays null until someone
  // chooses the default (#2756).
  proposedBy: { field: "proposed_by" },
  // source is where the preference came from, and says where its proposal
  // came from too: via, client, harness, model, session, turns and a
  // transcript pinned by hash (#2708).
  source: { field: "source" },
};
