// Cell Beta — all K8s resources for the beta tenant cell.

import { createCell } from "./factory";
import { cells } from "../config";

const beta = cells.find((c) => c.name === "beta")!;

export const {
  namespace: betaNamespace,
  resourceQuota: betaResourceQuota,
  limitRange: betaLimitRange,
  defaultDeny: betaDefaultDeny,
  allowIngressFromSystem: betaAllowIngressFromSystem,
  serviceAccount: betaServiceAccount,
  deployment: betaDeployment,
  service: betaService,
  hpa: betaHpa,
  pdb: betaPdb,
  ingress: betaIngress,
} = createCell(beta);
