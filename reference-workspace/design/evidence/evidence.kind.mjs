// The evidence record kind (#3148, ws-082), data only: no imports, no code.
//
// chant workspace records --kind design/evidence/evidence.kind.mjs --json
// chant workspace records new design/evidence/evidence.kind.mjs --from <fields.json>
//
// One run of one contract's check: which contract and check ran, against
// which tree, by which runner, and the result per criterion. A record is a
// JSON file named for the SHA-256 of its bytes, and its id is that hash, the
// same string a pin of the file holds. records new writes it from the fields
// and never changes it afterwards, and the run that holds a work item's
// lease attaches it to a criterion with chant workspace work evidence --path
// design/evidence/<id>.json. It has no lifecycle and supersedes nothing.
// Studio's factory writes the same fields (arugula-salad/studio#47), so its
// earlier evidence files read as this kind.
export const recordKind = {
  name: "evidence",
  location: { dir: ".", match: "^[0-9a-f]{64}\\.json$" },
  format: "json",
  schema: { id: "urn:intentius:chant:evidence:1", path: "evidence.schema.json" },
  idFrom: "sha256",
  // The build behind a run, when a builder made what was checked: the harness,
  // model and conversation (#2708).
  source: { field: "source" },
};
