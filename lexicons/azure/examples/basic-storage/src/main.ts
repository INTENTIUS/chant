import { StorageAccountSecure, Concat, UniqueString, Azure } from "@intentius/chant-lexicon-azure";

export const { storageAccount } = StorageAccountSecure({
  name: Concat("chantstore", UniqueString(Azure.ResourceGroupId)) as unknown as string,
  sku: "Standard_LRS",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "dev" },
});
