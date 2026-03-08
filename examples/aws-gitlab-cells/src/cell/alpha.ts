// Cell Alpha — all K8s resources for the alpha tenant cell.

import { createCell } from "./factory";
import { cells } from "../config";

const alpha = cells.find((c) => c.name === "alpha")!;

export const {
  namespace: alphaNamespace,
  resourceQuota: alphaResourceQuota,
  limitRange: alphaLimitRange,
  defaultDeny: alphaDefaultDeny,
  allowIngressFromSystem: alphaAllowIngressFromSystem,
  serviceAccount: alphaServiceAccount,
  deployment: alphaDeployment,
  service: alphaService,
  hpa: alphaHpa,
  pdb: alphaPdb,
  ingress: alphaIngress,
} = createCell(alpha);
