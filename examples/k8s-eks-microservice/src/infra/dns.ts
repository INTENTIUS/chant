// DNS and TLS: Route53 hosted zone + ACM certificate with DNS validation.
//
// After the first deploy, update your domain registrar's NS records to the
// nameservers shown in the stack outputs (`nameServersOutput`).

import {
  HostedZone,
  HostedZone_HostedZoneConfig,
  AcmCertificate,
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

// DNS validation — cert goes to PENDING_VALIDATION immediately.
// Once NS records are delegated to Route53 (see nameServersOutput),
// create the CNAME validation record in the hosted zone to complete
// validation. The ALB can use the cert ARN before validation completes.
export const certificate = new AcmCertificate({
  DomainName: Ref(domainName),
  ValidationMethod: "DNS",
});

export const certificateArnOutput = stackOutput(certificate.Id, {
  description: "ACM certificate ARN",
});

export const hostedZoneIdOutput = stackOutput(hostedZone.Id, {
  description: "Route53 hosted zone ID",
});

export const nameServersOutput = stackOutput(hostedZone.NameServers as any, {
  description:
    "Route53 nameservers — point your domain registrar NS records here",
});
