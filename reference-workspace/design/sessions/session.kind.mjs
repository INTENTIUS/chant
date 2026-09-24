// The review-session record kind (#2673, #2650 C10), data only: no imports,
// no code.
//
// chant workspace records --kind design/sessions/session.kind.mjs --json
// chant workspace records --kind design/sessions/session.kind.mjs --since <open commit> --at <close commit> --json
//
// A session is a group walking an agenda of records together. It keeps who
// attended and the verdicts it produced, and it is sealed when it closes.
// Each verdict it produced is also an entry in the judged decision's reviews
// list, whose session field names the session. chud's session files (such
// as sessions/S-0001.json) are the starting shape; sessions are markdown
// front matter here because that is the only record format chant reads
// (#2664).
export const recordKind = {
  name: "session",
  location: { dir: ".", match: "^S-[0-9]{4,}-.+\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:intentius:chant:session:1", path: "session.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["open", "closed"],
  // A closed session never changes: records checks its seal on every read.
  closedStates: ["closed"],
  // The kind contract requires a supersedes declaration (#2664 proposes making
  // it optional). The session schema has no supersedes field, so a session
  // never supersedes another.
  supersedes: { field: "supersedes", key: "session" },
  // verdicts: the verdicts the session produced, each naming a decision.
  // seal: the lowercase hex sha256 of the file with LF line endings and
  // without the closed_digest line, written when the session closes.
  // subjects: the decisions the verdicts name. Entries of their reviews list
  // (the decision kind's reviews.field) name a session.
  session: {
    verdicts: "verdicts",
    seal: "closed_digest",
    subjects: { kind: "../../decisions/decision.kind.mjs" },
  },
};
