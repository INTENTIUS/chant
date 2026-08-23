// Cross-lexicon configuration.
// Every value is declared in chant.config.ts's buildParams. Supply with
// --param, --params-file, or the env vars named there.

import { params } from "@intentius/chant/params";

export const config = {
  clusterName: params.clusterName as string,
  projectId: params.projectId as string,
  region: params.region as string,
  appGsaEmail: params.appGsaEmail as string,
  externalDnsGsaEmail: params.externalDnsGsaEmail as string,
  fluentBitGsaEmail: params.fluentBitGsaEmail as string,
  otelGsaEmail: params.otelGsaEmail as string,
  domain: params.domain as string,
  appImage: params.appImage as string,
};
