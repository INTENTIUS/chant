import { defaultTags } from "@intentius/chant-lexicon-aws";

// Stack-wide. The per-service `Service` tag the two single-service stacks
// carried has no stack-wide value now that both services live here.
export const tags = defaultTags([
  { Key: "Project", Value: "chant-example" },
]);
