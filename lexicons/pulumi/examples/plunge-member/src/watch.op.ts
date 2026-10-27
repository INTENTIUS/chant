import { PulumiWatchOp } from "@intentius/chant-lexicon-pulumi";

/**
 * The watch for a member on plunge. No `engine` is set, so the activities
 * read `infra/Pulumi.yaml`'s backend URL and run `plunge preview --json` and
 * one `plunge drift --resource <urn> --stream` per resource in the export.
 * Neither changes the stack.
 */
export const { op } = PulumiWatchOp({
  name: "infra-plunge-watch",
  member: "infra",
  dir: "./infra",
  schedule: "0 6 * * *",
});

export default op;
