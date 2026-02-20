import { Instance } from "@intentius/chant-lexicon-aws";

const regionAMIs: Record<string, string> = {
  "us-east-1": "ami-12345678",
  "us-west-2": "ami-87654321",
  "eu-west-1": "ami-abcdef01",
};

export const server = new Instance({
  imageId: regionAMIs["us-east-1"],
  instanceType: "t3.micro",
});
