// The answers to the workspace's decision points (ws-058, #2739), data only:
// no imports, no code.
//
// chant workspace points --open --json
// chant workspace points ask slice-tier --inputs inputs.json --subject W-002
// chant workspace points answer <id> --answer medium --by <name>
//
// The points are declared in ../decisions/points.json: typed questions, the
// read-contract outputs they read, and a table, model and quorum chain. Each
// answer is one record here, named for the point and its inputs' hash, so the
// same question is answered once. A table's answer is answered, a model's is
// proposed until a person confirms it, and a question nobody before the
// quorum answered is escalated to people. answer.schema.json is a copy of the
// one @intentius/chant ships as workspace/point-answer.schema.json.
export const recordKind = {
  name: "answer",
  location: { dir: ".", match: "^[a-z][a-z0-9-]*-[0-9a-f]{12}\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:intentius:chant:point-answer:1", path: "answer.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["escalated", "proposed", "answered"],
  closedStates: ["answered"],
  constrains: { field: "constrains" },
  source: { field: "source" },
  answers: { points: "../decisions/points.json" },
};
