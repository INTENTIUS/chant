// Cross-lexicon configuration.
// Every value is declared in chant.config.ts's buildParams. Supply with
// --param, --params-file, or the env vars named there.

import { params } from "@intentius/chant/params";

export const config = {
  clusterName: params.clusterName as string,
  region: params.region as string,
  appRoleArn: params.appRoleArn as string,
  albCertificateArn: params.albCertificateArn as string,
  externalDnsRoleArn: params.externalDnsRoleArn as string,
  fluentBitRoleArn: params.fluentBitRoleArn as string,
  adotRoleArn: params.adotRoleArn as string,
  domain: params.domain as string,
  appImage: params.appImage as string,
};
