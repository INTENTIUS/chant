// DNS: Route53 hosted zone for the EKS CockroachDB UI subdomain.
// After deploy, delegate NS records at your registrar.

import {
  HostedZone,
  HostedZone_HostedZoneConfig,
  stackOutput,
} from "@intentius/chant-lexicon-aws";
import { config } from "../config";

export const hostedZone = new HostedZone({
  Name: config.domain,
  HostedZoneConfig: new HostedZone_HostedZoneConfig({
    Comment: "CockroachDB EKS UI — managed by chant",
  }),
});

export const hostedZoneIdOutput = stackOutput(hostedZone.Id, {
  description: `Route53 hosted zone ID for ${config.domain}`,
});
