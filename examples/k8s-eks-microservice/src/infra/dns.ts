// DNS: Route53 hosted zone for the application domain.
//
// The hosted zone is created in-stack. After deploy, delegate NS records
// at your registrar (see nameServersOutput). The ACM certificate is
// created separately via `just deploy-cert` after NS delegation.

import {
  HostedZone,
  HostedZone_HostedZoneConfig,
  Join,
  Ref,
  stackOutput,
} from "@intentius/chant-lexicon-aws";
import { domainName } from "./params";

export const hostedZone = new HostedZone({
  Name: Ref(domainName),
  HostedZoneConfig: new HostedZone_HostedZoneConfig({
    Comment: "EKS microservice — managed by chant",
  }),
});

export const hostedZoneIdOutput = stackOutput(hostedZone.Id, {
  description: "Route53 hosted zone ID",
});
