import { ContainerInstance, Azure } from "@intentius/chant-lexicon-azure";

export const { containerGroup } = ContainerInstance({
  name: "chant-ci",
  image: "mcr.microsoft.com/azuredocs/aci-helloworld",
  cpu: 1,
  memoryInGb: 1.5,
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "dev" },
});
