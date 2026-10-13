// The review-session record kind (#2673, #2650 C10), data only: no imports,
// no code.
//
// chant workspace records --kind design/sessions/session.kind.mjs --json
// chant workspace records --kind design/sessions/session.kind.mjs --since <open commit> --at <close commit> --json
// chant workspace records --since S-0002 --json
// chant workspace records close S-0002
//
// A session is a group walking an agenda of records together. It keeps who
// attended and the verdicts it produced, and it is sealed when it closes.
// Each verdict it produced is also an entry in the judged record's reviews
// list, whose session field names the session. Its verdicts judge decisions,
// contracts and drivers (#3148, ws-082): studio's design sessions, which
// approved contracts and signed off drivers, are this kind, and so is a
// comment-mode review of the app's UI, one session per review batch, with
// its anchored comments, the agent's answers and the rounds of replies
// (#3350, ws-083). chud's session
// files (such as sessions/S-0001.json) are the starting shape; sessions are
// markdown front matter so that records new, amend, review and close write
// them.
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
  // seal: the whole-file seal, sha256: and the hex SHA-256 of the JCS form
  // of the session without closed_digest (front matter as core, the text
  // below it as body, line endings LF), written when the session closes
  // (#2546).
  // subjects: the kinds of the records the verdicts name, decisions,
  // contracts and drivers. Entries of their reviews lists (each kind's
  // reviews.field) name a session.
  // openedRev, closedRev and closedOn (#2693): the fields records new and
  // records close write, the commits the session opened and closed at and
  // the time it closed. records --since <session id> reads the commits.
  session: {
    verdicts: "verdicts",
    seal: "closed_digest",
    subjects: { kinds: ["../../decisions/decision.kind.mjs", "../contracts/contract.kind.mjs", "../drivers/driver.kind.mjs"] },
    openedRev: "opened_rev",
    closedRev: "closed_rev",
    closedOn: "closed",
  },
};
