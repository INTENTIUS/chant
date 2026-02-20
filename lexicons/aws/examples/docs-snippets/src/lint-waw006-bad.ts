import { Bucket } from "@intentius/chant-lexicon-aws";

// chant-disable-next-line WAW006
export const bucket = new Bucket({
  bucketName: "my-bucket",
});
