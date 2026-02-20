import { Sub, AWS } from "@intentius/chant-lexicon-aws";

export const endpoint = Sub`s3.${AWS.Region}.amazonaws.com/${AWS.StackName}`;
