/**
 * SecureProject composite — Project + IAMAuditConfig + Service enablement + owner IAM + LoggingSink.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  ResourcemanagerProject,
  IAMAuditConfig,
  ServiceusageService,
  IAMPolicyMember,
  LogSink,
} from "../generated";

export interface SecureProjectProps {
  /** Project name (also used as project ID). */
  name: string;
  /** Organization ID or folder ID for the parent. */
  orgId?: string;
  /** Folder ID for the parent (alternative to orgId). */
  folderId?: string;
  /** Billing account ID. */
  billingAccountRef?: string;
  /** Owner email (IAM member format, e.g., "user:admin@example.com"). */
  owner?: string;
  /** GCP APIs to enable (default: common APIs). */
  enabledApis?: string[];
  /** Logging sink destination (e.g., BigQuery dataset or Cloud Storage bucket). */
  loggingSinkDestination?: string;
  /** Logging sink filter (default: all audit logs). */
  loggingSinkFilter?: string;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
  /** Per-member defaults for customizing individual resources. */
  defaults?: {
    project?: Partial<ConstructorParameters<typeof ResourcemanagerProject>[0]>;
    auditConfig?: Partial<ConstructorParameters<typeof IAMAuditConfig>[0]>;
    ownerIam?: Partial<ConstructorParameters<typeof IAMPolicyMember>[0]>;
    loggingSink?: Partial<ConstructorParameters<typeof LogSink>[0]>;
  };
}

export const SecureProject = Composite<SecureProjectProps>((props) => {
  const {
    name,
    orgId,
    folderId,
    billingAccountRef,
    owner,
    enabledApis = [
      "compute.googleapis.com",
      "container.googleapis.com",
      "iam.googleapis.com",
      "logging.googleapis.com",
      "monitoring.googleapis.com",
    ],
    loggingSinkDestination,
    loggingSinkFilter = 'logName:"cloudaudit.googleapis.com"',
    labels: extraLabels = {},
    namespace,
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const project = new ResourcemanagerProject(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "project" },
    },
    ...(orgId && { organizationRef: { external: orgId } }),
    ...(folderId && { folderRef: { external: folderId } }),
    ...(billingAccountRef && { billingAccountRef: { external: billingAccountRef } }),
  } as Record<string, unknown>, defs?.project));

  const auditConfig = new IAMAuditConfig(mergeDefaults({
    metadata: {
      name: `${name}-audit`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "audit" },
    },
    service: "allServices",
    auditLogConfigs: [
      { logType: "ADMIN_READ" },
      { logType: "DATA_READ" },
      { logType: "DATA_WRITE" },
    ],
  } as Record<string, unknown>, defs?.auditConfig));

  // Spread services into named members (service_compute, service_container, etc.)
  // so the Composite validator accepts them as individual Declarables.
  const serviceEntries: Record<string, any> = {};
  for (const api of enabledApis) {
    const key = `service_${api.split(".")[0]}`;
    serviceEntries[key] = new ServiceusageService({
      metadata: {
        name: `${name}-${api.split(".")[0]}`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "service" },
      },
      resourceID: api,
    } as Record<string, unknown>);
  }

  const result: Record<string, any> = { project, auditConfig, ...serviceEntries };

  if (owner) {
    result.ownerIam = new IAMPolicyMember(mergeDefaults({
      metadata: {
        name: `${name}-owner`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "iam" },
      },
      member: owner,
      role: "roles/owner",
      resourceRef: {
        apiVersion: "resourcemanager.cnrm.cloud.google.com/v1beta1",
        kind: "Project",
        name,
      },
    } as Record<string, unknown>, defs?.ownerIam));
  }

  if (loggingSinkDestination) {
    result.loggingSink = new LogSink(mergeDefaults({
      metadata: {
        name: `${name}-audit-sink`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "logging" },
      },
      destination: loggingSinkDestination,
      filter: loggingSinkFilter,
    } as Record<string, unknown>, defs?.loggingSink));
  }

  return result;
}, "SecureProject");
