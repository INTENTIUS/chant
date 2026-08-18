/**
 * Render naming strategy — maps Render::{Group}::{Kind} type names to
 * user-friendly TypeScript class names.
 */

import {
  NamingStrategy as CoreNamingStrategy,
  type NamingConfig,
  type NamingInput,
} from "@intentius/chant/codegen/naming";
import { renderShortName, renderServiceName, type RenderParseResult } from "../spec/parse";

export { propertyTypeName, extractDefName } from "@intentius/chant/codegen/naming";

const renderNamingConfig: NamingConfig = {
  priorityNames: {
    "Render::Services::WebService": "WebService",
    "Render::Services::StaticSite": "StaticSite",
    "Render::Services::PrivateService": "PrivateService",
    "Render::Services::BackgroundWorker": "BackgroundWorker",
    "Render::Services::CronJob": "CronJob",
    "Render::Datastores::Postgres": "Postgres",
    "Render::Datastores::KeyValue": "KeyValue",
    "Render::Config::EnvGroup": "EnvGroup",
    "Render::Projects::Project": "Project",
    "Render::Projects::Environment": "Environment",
  },

  priorityAliases: {},

  priorityPropertyAliases: {},

  serviceAbbreviations: {
    Services: "Services",
    Datastores: "Datastores",
    Config: "Config",
    Projects: "Projects",
  },

  shortName: renderShortName,
  serviceName: renderServiceName,
};

/**
 * Render-specific naming strategy. Extends the core strategy with the render config.
 */
export class NamingStrategy extends CoreNamingStrategy {
  constructor(results: RenderParseResult[]) {
    const inputs: NamingInput[] = results.map((r) => ({
      typeName: r.resource.typeName,
      propertyTypes: r.propertyTypes,
    }));
    super(inputs, renderNamingConfig);
  }
}
