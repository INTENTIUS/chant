import { SqlDatabase, Azure, Parameter } from "@intentius/chant-lexicon-azure";

export const adminLogin = new Parameter("String", {
  description: "SQL admin login",
  defaultValue: "sqladmin",
});

export const adminPassword = new Parameter("String", {
  description: "SQL admin password",
});

export const { server, database, firewallRule } = SqlDatabase({
  name: "chant-sql",
  adminLogin: "sqladmin",
  adminPassword: "[parameters('sqlAdminPassword')]",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "dev" },
});
