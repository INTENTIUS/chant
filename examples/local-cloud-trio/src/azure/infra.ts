import { StorageAccountSecure } from "@intentius/chant-lexicon-azure";

// Azure object store — a storage account (secure defaults). Synthesizes to an
// ARM template, deployed to floci-az via `azApply` (direct ARM-resource CRUD,
// since floci-az has no `az deployment`). Literal name so the demo can verify it.
export const { storageAccount } = StorageAccountSecure({
  name: "triostore",
  location: "eastus",
  sku: "Standard_LRS",
  tags: { project: "cross-cloud-demo" },
});
