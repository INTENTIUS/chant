/**
 * SecureProject composite — Project + IAMAuditConfig + Service enablement + owner IAM + LoggingSink.
 */

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
}

export interface SecureProjectResult {
  project: Record<string, unknown>;
  auditConfig: Record<string, unknown>;
  services: Record<string, unknown>[];
  ownerIam?: Record<string, unknown>;
  loggingSink?: Record<string, unknown>;
}

export function SecureProject(props: SecureProjectProps): SecureProjectResult {
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
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const project: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "project" },
    },
    ...(orgId && { organizationRef: { external: orgId } }),
    ...(folderId && { folderRef: { external: folderId } }),
    ...(billingAccountRef && { billingAccountRef: { external: billingAccountRef } }),
  };

  const auditConfig: Record<string, unknown> = {
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
  };

  const services = enabledApis.map((api) => ({
    metadata: {
      name: `${name}-${api.split(".")[0]}`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "service" },
    },
    resourceID: api,
  }));

  const result: SecureProjectResult = { project, auditConfig, services };

  if (owner) {
    result.ownerIam = {
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
    };
  }

  if (loggingSinkDestination) {
    result.loggingSink = {
      metadata: {
        name: `${name}-audit-sink`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "logging" },
      },
      destination: loggingSinkDestination,
      filter: loggingSinkFilter,
    };
  }

  return result;
}
