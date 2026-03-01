/**
 * AppService composite — App Service Plan + Web App.
 *
 * A higher-level construct for deploying a Web App on Azure App Service
 * with a plan and common defaults (HTTPS-only, TLS 1.2, managed identity).
 */

import { markAsAzureResource } from "./from-arm";

export interface AppServiceProps {
  /** Web app name (globally unique). */
  name: string;
  /** App Service Plan SKU (default: "B1"). */
  sku?: string;
  /** Runtime stack (default: "NODE|18-lts"). */
  runtime?: string;
  /** Azure region (default: resource group location). */
  location?: string;
  /** Resource tags. */
  tags?: Record<string, string>;
}

export interface AppServiceResult {
  plan: Record<string, unknown>;
  webApp: Record<string, unknown>;
}

/**
 * Create an AppService composite — returns property objects for
 * an App Service Plan and a Web App.
 *
 * @example
 * ```ts
 * import { AppService } from "@intentius/chant-lexicon-azure";
 *
 * const { plan, webApp } = AppService({
 *   name: "my-web-app",
 *   sku: "P1v3",
 *   runtime: "DOTNETCORE|8.0",
 *   tags: { environment: "staging" },
 * });
 *
 * export { plan, webApp };
 * ```
 */
export function AppService(props: AppServiceProps): AppServiceResult {
  const {
    name,
    sku = "B1",
    runtime = "NODE|18-lts",
    location = "[resourceGroup().location]",
    tags = {},
  } = props;

  const commonTags: Record<string, string> = {
    "managed-by": "chant",
    ...tags,
  };

  const planName = `${name}-plan`;

  const plan: Record<string, unknown> = {
    type: "Microsoft.Web/serverfarms",
    apiVersion: "2022-09-01",
    name: planName,
    location,
    tags: commonTags,
    sku: {
      name: sku,
    },
    kind: "linux",
    properties: {
      reserved: true,
    },
  };

  const webApp: Record<string, unknown> = {
    type: "Microsoft.Web/sites",
    apiVersion: "2022-09-01",
    name,
    location,
    tags: commonTags,
    kind: "app,linux",
    identity: {
      type: "SystemAssigned",
    },
    properties: {
      serverFarmId: `[resourceId('Microsoft.Web/serverfarms', '${planName}')]`,
      httpsOnly: true,
      siteConfig: {
        linuxFxVersion: runtime,
        minTlsVersion: "1.2",
        ftpsState: "Disabled",
        alwaysOn: true,
        http20Enabled: true,
      },
    },
  };

  markAsAzureResource(plan);
  markAsAzureResource(webApp);

  return { plan, webApp };
}
