/**
 * FunctionApp composite — Consumption Function App with security defaults.
 *
 * Creates an App Service Plan (Y1 Consumption), Function App, and
 * Storage Account with SystemAssigned identity, HTTPS-only, TLS 1.2,
 * and FTPS disabled.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  AppServicePlan,
  AppService as AppServiceResource,
  StorageAccount,
} from "../generated";

export interface FunctionAppProps {
  /** Function app name. */
  name: string;
  /** Azure region (default: resource group location). */
  location?: string;
  /** Runtime stack (default: "node" — values: node, dotnet, python, java). */
  runtime?: string;
  /** Runtime version (default: "~4"). */
  runtimeVersion?: string;
  /** Resource tags. */
  tags?: Record<string, string>;
  /** Per-member defaults. */
  defaults?: {
    plan?: Partial<ConstructorParameters<typeof AppServicePlan>[0]>;
    functionApp?: Partial<ConstructorParameters<typeof AppServiceResource>[0]>;
    storageAccount?: Partial<ConstructorParameters<typeof StorageAccount>[0]>;
  };
}

export interface FunctionAppResult {
  plan: InstanceType<typeof AppServicePlan>;
  functionApp: InstanceType<typeof AppServiceResource>;
  storageAccount: InstanceType<typeof StorageAccount>;
}

export const FunctionApp = Composite<FunctionAppProps>((props) => {
  const {
    name,
    location = "[resourceGroup().location]",
    runtime = "node",
    runtimeVersion = "~4",
    tags = {},
    defaults,
  } = props;

  const mergedTags = { "managed-by": "chant", ...tags };
  const storageName = `${name.replace(/[^a-z0-9]/g, "")}st`;

  const storageAccount = new StorageAccount(mergeDefaults({
    name: storageName,
    location,
    tags: mergedTags,
    sku: { name: "Standard_LRS" },
    kind: "StorageV2",
    supportsHttpsTrafficOnly: true,
    minimumTlsVersion: "TLS1_2",
    allowBlobPublicAccess: false,
  }, defaults?.storageAccount), { apiVersion: "2023-01-01" });

  const plan = new AppServicePlan(mergeDefaults({
    name: `${name}-plan`,
    location,
    tags: mergedTags,
    sku: { name: "Y1", tier: "Dynamic" },
    kind: "functionapp",
    reserved: true,
  }, defaults?.plan), { apiVersion: "2023-01-01" });

  const functionApp = new AppServiceResource(mergeDefaults({
    name,
    location,
    tags: mergedTags,
    kind: "functionapp",
    identity: { type: "SystemAssigned" },
    serverFarmId: `[resourceId('Microsoft.Web/serverfarms', '${name}-plan')]`,
    httpsOnly: true,
    siteConfig: {
      minTlsVersion: "1.2",
      ftpsState: "Disabled",
      appSettings: [
        { name: "AzureWebJobsStorage", value: `[concat('DefaultEndpointsProtocol=https;AccountName=', '${storageName}', ';AccountKey=', listKeys(resourceId('Microsoft.Storage/storageAccounts', '${storageName}'), '2023-01-01').keys[0].value)]` },
        { name: "FUNCTIONS_EXTENSION_VERSION", value: runtimeVersion },
        { name: "FUNCTIONS_WORKER_RUNTIME", value: runtime },
      ],
    },
  }, defaults?.functionApp), {
    apiVersion: "2023-01-01",
    DependsOn: [
      `[resourceId('Microsoft.Web/serverfarms', '${name}-plan')]`,
      `[resourceId('Microsoft.Storage/storageAccounts', '${storageName}')]`,
    ],
  });

  return { plan, functionApp, storageAccount };
}, "FunctionApp");
