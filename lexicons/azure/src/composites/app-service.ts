/**
 * AppService composite — App Service Plan + Web App.
 *
 * A higher-level construct for deploying a Web App on Azure App Service
 * with a plan and common defaults (HTTPS-only, TLS 1.2, managed identity).
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { AppServicePlan, AppService as AppServiceResource } from "../generated";

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
  /** Per-member defaults. */
  defaults?: {
    plan?: Partial<ConstructorParameters<typeof AppServicePlan>[0]>;
    webApp?: Partial<ConstructorParameters<typeof AppServiceResource>[0]>;
  };
}

export interface AppServiceResult {
  plan: InstanceType<typeof AppServicePlan>;
  webApp: InstanceType<typeof AppServiceResource>;
}

/**
 * Create an AppService composite — returns an App Service Plan and a Web App.
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
export const AppService = Composite<AppServiceProps>((props) => {
  const {
    name,
    sku = "B1",
    runtime = "NODE|18-lts",
    location = "[resourceGroup().location]",
    tags = {},
    defaults,
  } = props;

  const commonTags: Record<string, string> = {
    "managed-by": "chant",
    ...tags,
  };

  const planName = `${name}-plan`;

  const plan = new AppServicePlan(mergeDefaults({
    name: planName,
    location,
    tags: commonTags,
    sku: {
      name: sku,
    },
    kind: "linux",
    reserved: true,
  }, defaults?.plan), { apiVersion: "2022-09-01" });

  const webApp = new AppServiceResource(mergeDefaults({
    name,
    location,
    tags: commonTags,
    kind: "app,linux",
    identity: {
      type: "SystemAssigned",
    },
    serverFarmId: `[resourceId('Microsoft.Web/serverfarms', '${planName}')]`,
    httpsOnly: true,
    siteConfig: {
      linuxFxVersion: runtime,
      minTlsVersion: "1.2",
      ftpsState: "Disabled",
      alwaysOn: true,
      http20Enabled: true,
    },
  }, defaults?.webApp), { apiVersion: "2022-09-01" });

  return { plan, webApp };
}, "AppService");
