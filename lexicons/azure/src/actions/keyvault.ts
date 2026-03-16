/**
 * Azure Key Vault RBAC built-in role constants.
 */
export const KeyVaultRoles = {
  Administrator: "Key Vault Administrator",
  CertificatesOfficer: "Key Vault Certificates Officer",
  CryptoOfficer: "Key Vault Crypto Officer",
  CryptoUser: "Key Vault Crypto User",
  Reader: "Key Vault Reader",
  SecretsOfficer: "Key Vault Secrets Officer",
  SecretsUser: "Key Vault Secrets User",
} as const;
