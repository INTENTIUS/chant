// The work item record kind (#2683), data only: no imports, no code.
//
// chant workspace records --kind work/work.kind.mjs --json
// chant workspace graph --intent <region> --kind decisions/decision.kind.mjs --kind work/work.kind.mjs
//
// A work item is a record in the workspace, with its dependencies written
// inside it, that people and agents share as one queue with no server. Most
// come from a gap the intent graph reports, named in `source.finding`.
// Records are Markdown with front matter: an item keeps its id while its
// state changes, so it is not content-addressed. ws-053 (#2664) lets a kind
// read `format: "json"`, but `records new` and `records amend` write Markdown
// only, so work items stay Markdown until the write commands write JSON.
export const recordKind = {
  name: "work",
  location: { dir: ".", match: "^W-[0-9]{3,}-.+\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:intentius:chant:work:1", path: "work.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["open", "in-progress", "done", "dropped"],
  closedStates: ["done", "dropped"],
  // Takes effect from a done or dropped item, the closed states.
  supersedes: { field: "supersedes", key: "work" },
  // Evidence is the proof of done: links, or workspace files pinned by hash.
  pins: { field: "evidence" },
  // The same grammar as a decision's: member:, path:, issues and decision ids.
  constrains: { field: "constrains" },
  // needs and implements, the decisions they name, and when an item is ready.
  work: {
    needs: "needs",
    implements: "implements",
    decisions: "../decisions/decision.kind.mjs",
    open: "open",
    done: "done",
    closedOn: "closed_on",
  },
};
