// The driver record kind (#3148, ws-082), data only: no imports, no code.
//
// chant workspace records --kind design/drivers/driver.kind.mjs --json
//
// A driver groups contracts under one intent: what its member contracts add
// up to once all of them hold. Its body is the design notes. A driver has no
// lifecycle of its own; its contracts carry theirs. A review session may
// judge a driver beside decisions and contracts, as a sign-off on the group.
export const recordKind = {
  name: "driver",
  location: { dir: ".", match: "^D-[0-9]{3,}-.+\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:intentius:chant:driver:1", path: "driver.schema.json" },
  idField: "id",
};
