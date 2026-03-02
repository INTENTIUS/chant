import { Sub, AWS } from "@intentius/chant-lexicon-aws";

export const regionEndpoint = Sub`s3.${AWS.Region}.amazonaws.com/${AWS.StackName}`;
