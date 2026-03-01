import { SqlDatabase, Azure } from "@intentius/chant-lexicon-azure";
import { CoreParameter } from "@intentius/chant";

export const adminLogin = new CoreParameter({
  name: "sqlAdminLogin",
  type: "string",
  default: "sqladmin",
});

export const adminPassword = new CoreParameter({
  name: "sqlAdminPassword",
  type: "string",
});

export const { server, database, firewallRule } = SqlDatabase({
  name: "chant-sql",
  adminLogin: "sqladmin",
  adminPassword: "[parameters('sqlAdminPassword')]",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "dev" },
});
