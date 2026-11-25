/**
 * Render naming strategy — maps Render::{Group}::{Kind} type names to
 * user-friendly TypeScript class names.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NamingStrategy as CoreNamingStrategy,
  publishedNamingConfig,
  readPublishedNames,
  readPublishedSources,
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
  /**
   * @param published type name -> the name the lexicon already published for
   *   it, normally {@link publishedNames}. Each keeps its name; see core's
   *   `publishedNamingConfig`.
   */
  constructor(results: RenderParseResult[], published: Record<string, string> = {}) {
    const inputs: NamingInput[] = results.map((r) => ({
      typeName: r.resource.typeName,
      propertyTypes: r.propertyTypes,
    }));
    super(inputs, publishedNamingConfig(inputs, renderNamingConfig, published));
  }
}

/** The committed surface snapshot beside this package's `src/`. */
export const SURFACE_SNAPSHOT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "surface.snapshot.json");

/**
 * The names the render lexicon has published, read from its committed surface
 * snapshot: type name -> name. Property types are standalone inputs to the
 * naming step here, so they are reserved alongside the resources (chant
 * #5569). Empty when there is no snapshot.
 */
export function publishedNames(snapshotPath: string = SURFACE_SNAPSHOT_PATH): Record<string, string> {
  return { ...readPublishedNames(snapshotPath, "property"), ...readPublishedNames(snapshotPath) };
}

/**
 * The property-type names the render lexicon has published, by the upstream
 * schema each came from: schema -> the last segment of its type name. The
 * parser reads it so a published name stays with its schema. Empty when there
 * is no snapshot or it records no sources.
 */
export function publishedSchemaNames(snapshotPath: string = SURFACE_SNAPSHOT_PATH): Record<string, string> {
  return readPublishedSources(snapshotPath);
}
