/**
 * FunctionApp composite — Consumption Function App with security defaults.
 *
 * Creates an App Service Plan (Y1 Consumption), Function App, and
 * Storage Account with SystemAssigned identity, HTTPS-only, TLS 1.2,
 * and FTPS disabled.
 */

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
}

export interface FunctionAppResult {
  plan: Record<string, unknown>;
  functionApp: Record<string, unknown>;
  storageAccount: Record<string, unknown>;
}

export function FunctionApp(props: FunctionAppProps): FunctionAppResult {
  const {
    name,
    location = "[resourceGroup().location]",
    runtime = "node",
    runtimeVersion = "~4",
    tags = {},
  } = props;

  const mergedTags = { "managed-by": "chant", ...tags };
  const storageName = `${name.replace(/[^a-z0-9]/g, "")}st`;

  const storageAccount: Record<string, unknown> = {
    type: "Microsoft.Storage/storageAccounts",
    apiVersion: "2023-01-01",
    name: storageName,
    location,
    tags: mergedTags,
    sku: { name: "Standard_LRS" },
    kind: "StorageV2",
    properties: {
      supportsHttpsTrafficOnly: true,
      minimumTlsVersion: "TLS1_2",
      allowBlobPublicAccess: false,
    },
  };

  const plan: Record<string, unknown> = {
    type: "Microsoft.Web/serverfarms",
    apiVersion: "2023-01-01",
    name: `${name}-plan`,
    location,
    tags: mergedTags,
    sku: { name: "Y1", tier: "Dynamic" },
    kind: "functionapp",
    properties: {
      reserved: true,
    },
  };

  const functionApp: Record<string, unknown> = {
    type: "Microsoft.Web/sites",
    apiVersion: "2023-01-01",
    name,
    location,
    tags: mergedTags,
    kind: "functionapp",
    identity: { type: "SystemAssigned" },
    properties: {
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
    },
    dependsOn: [
      `[resourceId('Microsoft.Web/serverfarms', '${name}-plan')]`,
      `[resourceId('Microsoft.Storage/storageAccounts', '${storageName}')]`,
    ],
  };

  return { plan, functionApp, storageAccount };
}
