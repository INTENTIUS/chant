// Cross-lexicon configuration.
// Every value is declared in chant.config.ts's buildParams. Supply with
// --param, --params-file, or the env vars named there.

import { params } from "@intentius/chant/params";

export const config = {
  clusterName: params.clusterName as string,
  resourceGroup: params.resourceGroup as string,
  subscriptionId: params.subscriptionId as string,
  tenantId: params.tenantId as string,
  appClientId: params.appClientId as string,
  externalDnsClientId: params.externalDnsClientId as string,
  monitorClientId: params.monitorClientId as string,
  domain: params.domain as string,
  appImage: params.appImage as string,
};
