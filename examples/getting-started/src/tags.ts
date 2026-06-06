// A plain `const`, applied to every resource as default tags.
//
// This is static data — fixed by the source, resolved at synthesis. Reusing a
// const like this is the whole of "layered configuration" at its simplest.
import { defaultTags } from "@intentius/chant-lexicon-aws";

export const tags = defaultTags([
  { Key: "Project", Value: "chant-getting-started" },
  { Key: "Level", Value: "L1-synthesis" },
]);
