/**
 * Azure Storage RBAC built-in role constants.
 */
export const StorageRoles = {
  BlobDataContributor: "Storage Blob Data Contributor",
  BlobDataReader: "Storage Blob Data Reader",
  BlobDataOwner: "Storage Blob Data Owner",
  AccountContributor: "Storage Account Contributor",
  QueueDataContributor: "Storage Queue Data Contributor",
  QueueDataReader: "Storage Queue Data Reader",
  TableDataContributor: "Storage Table Data Contributor",
  TableDataReader: "Storage Table Data Reader",
  FileDataPrivilegedContributor: "Storage File Data Privileged Contributor",
  FileDataPrivilegedReader: "Storage File Data Privileged Reader",
} as const;
