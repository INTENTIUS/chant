// DNS and TLS: Route53 hosted zone + ACM certificate with DNS validation.
//
// After the first deploy, update your domain registrar's NS records to the
// nameservers shown in the stack outputs (`nameServersOutput`).

import {
  HostedZone,
  HostedZone_HostedZoneConfig,
  AcmCertificate,
  AcmCertificate_DomainValidationOption,
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

export const certificate = new AcmCertificate({
  DomainName: Ref(domainName),
  ValidationMethod: "DNS",
  DomainValidationOptions: [
    new AcmCertificate_DomainValidationOption({
      DomainName: Ref(domainName),
      HostedZoneId: hostedZone.Id,
    }),
  ],
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
