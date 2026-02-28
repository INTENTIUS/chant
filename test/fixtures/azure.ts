import { StorageAccount, Azure } from "@intentius/chant-lexicon-azure";
export const storage = new StorageAccount({
  name: "smoketest",
  location: Azure.ResourceGroupLocation,
  kind: "StorageV2",
  sku: { name: "Standard_LRS" },
  supportsHttpsTrafficOnly: true,
  minimumTlsVersion: "TLS1_2",
  allowBlobPublicAccess: false,
});
