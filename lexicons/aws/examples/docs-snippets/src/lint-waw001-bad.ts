import { Sub, AWS } from "@intentius/chant-lexicon-aws";

// chant-disable-next-line WAW001
export const endpoint = Sub`s3.us-east-1.amazonaws.com/${AWS.StackName}`;
