// The contract record kind (#3148, ws-082), data only: no imports, no code.
//
// chant workspace records --kind design/contracts/contract.kind.mjs --current --json
//
// A contract is an acceptance criterion made formal: what a person can do,
// the criteria a check proves, and the check itself, a file pinned by hash.
// It is drafted, approved once its reviewers agree, and retired when nothing
// should be built against it any more. Studio's factory builds work items
// against approved contracts; a work kind links an item to its contract with
// work.contract (#3147). Each check run's result is an evidence record
// (../evidence/evidence.kind.mjs) that names the contract and its criteria.
export const recordKind = {
  name: "contract",
  location: { dir: ".", match: "^C-[0-9]{3,}-.+\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:intentius:chant:contract:1", path: "contract.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["draft", "approved", "retired"],
  // An approved contract changes only in its state, its check pins and its
  // reviews: anything else is a new contract that supersedes it. A retired
  // contract is final and sealed.
  closedStates: ["retired"],
  approval: { draft: 0, approved: 1, retired: 1 },
  seal: { field: "closed_digest" },
  // A bare id or a list of ids, as studio's contracts write it. A link takes
  // effect from an approved or retired contract.
  supersedes: { field: "supersedes" },
  // The contract's checks, each a workspace file pinned by the hash of its
  // bytes (#2549): records reports a check edited after it was pinned.
  pins: { field: "checks" },
  // Verdicts on the contract, given in a review session (whose subjects
  // include this kind) or with records review, and who approved it.
  reviews: { field: "reviews", decider: "approved_by" },
  // records new --by names a draft's proposer here (#2756).
  proposedBy: { field: "proposed_by" },
};
