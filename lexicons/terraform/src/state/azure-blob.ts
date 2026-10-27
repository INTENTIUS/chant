/**
 * The Azure Blob Storage client an azurerm backend's state uses: chant
 * core's (#4554, `@intentius/chant/object-store`): a blob's properties and
 * metadata, a snapshot, a block blob put, and the blob lease the backend
 * locks a state with, signed with Shared Key, a SAS, or an Entra token for
 * the job's OIDC identity.
 */
export { AZURE_AUTHORITY, AZURE_VERSION, AzureBlobClient, sharedKey, type AzureLocation, type AzureOidc, type AzureTarget, type BlobHead } from "@intentius/chant/object-store";
