import { KeyVaultSecure, Azure } from "@intentius/chant-lexicon-azure";

export const { vault } = KeyVaultSecure({
  name: "chant-vault",
  tenantId: Azure.TenantId as unknown as string,
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "dev" },
});
