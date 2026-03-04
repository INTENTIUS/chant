// DNS: Route53 hosted zone for eks.crdb.intentius.io.
// After deploy, delegate NS records at your registrar.

import {
  HostedZone,
  HostedZone_HostedZoneConfig,
  stackOutput,
} from "@intentius/chant-lexicon-aws";

export const hostedZone = new HostedZone({
  Name: "eks.crdb.intentius.io",
  HostedZoneConfig: new HostedZone_HostedZoneConfig({
    Comment: "CockroachDB EKS UI — managed by chant",
  }),
});

export const hostedZoneIdOutput = stackOutput(hostedZone.Id, {
  description: "Route53 hosted zone ID for eks.crdb.intentius.io",
});
