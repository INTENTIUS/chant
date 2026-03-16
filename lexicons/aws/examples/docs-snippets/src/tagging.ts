import { defaultTags, Sub, AWS } from "@intentius/chant-lexicon-aws";

export const tags = defaultTags([
  { Key: "Environment", Value: "production" },
  { Key: "Team", Value: "platform" },
  { Key: "Stack", Value: Sub`${AWS.StackName}` },
]);
