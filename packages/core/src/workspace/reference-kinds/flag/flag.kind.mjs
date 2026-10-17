// The feature flag record kind (#4024), data only: no imports, no code.
//
// chant workspace records --kind flags/flag.kind.mjs --json
//
// A flag is a workspace record a member's build reads as one build-time
// parameter: chant build --env <env> in that member takes the flag's value
// for the environment, and records it with source flag:<id>. Turning a flag
// on is a commit that changes this record, so it is reviewed, and the release
// cut from that commit carries the new value through the environment's gate.
//
// The canonical copy ships in @intentius/chant at
// src/workspace/reference-kinds/flag. A workspace copies this file and
// flag.schema.json into a directory of its own, such as flags/, names the
// kind file in chant.workspace.json's records, and points work.kind at its
// own work kind file.
export const recordKind = {
  name: "flag",
  location: { dir: ".", match: "^[a-z][a-z0-9-]{0,62}\\.flag\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:intentius:chant:flag:1", path: "flag.schema.json" },
  idField: "id",
  // The fields chant reads as the flag: the member and parameter it sets,
  // its owner, its value per environment, and the work item it hides, a
  // record of the work kind named here (relative to this file).
  flag: {
    member: "member",
    param: "param",
    owner: "owner",
    values: "values",
    work: { field: "work", kind: "../work/work.kind.mjs" },
  },
};
