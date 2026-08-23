/**
 * The project schema as a build artifact (#1697).
 *
 * CEDE010 can only validate a policy set against a schema the build emitted
 * beside it, and until now nothing emitted one: the `.cedarschema` drove
 * codegen and then stayed in the source tree, so every consumer build got the
 * parse-only advisory. This module closes that gap from two directions.
 *
 * `Schema` is a declarable a project can author by hand when it wants a
 * particular filename or a schema that is not the one in `chant.config.ts`.
 * `schemaBuildRoot` is the automatic path: the plugin's `buildRoots` hook
 * contributes one `Schema` entity per build, holding the resolved project
 * schema, so a project with a `cedar.schema` gets `dist/schema.cedarschema`
 * and full validation without declaring anything.
 *
 * The bundled default schema is never emitted. A project without its own
 * schema has policies the default may well reject, and CEDE010 failing a
 * build against a schema the project never wrote would be a worse surprise
 * than the advisory it replaces.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isPropertyDeclarable } from "@intentius/chant/declarable";
import type { BuildRootContext, BuildRootContribution } from "@intentius/chant/lexicon";
import { createResource } from "@intentius/chant/runtime";
import { getProps } from "./policy-text";
import { resolveSchemaPath } from "./spec/fetch";
import type { CedarGenerateConfig } from "./codegen/generate";
import { readFileSync } from "fs";
import { basename } from "path";

/** The entity type of a {@link Schema}. */
export const CEDAR_SCHEMA_TYPE = "Cedar::Schema";

/** The logical name the build-root contribution uses. */
export const CEDAR_SCHEMA_ENTITY_NAME = "cedarSchema";

/** Filename the schema is emitted under when `filename` is unset. */
export const CEDAR_SCHEMA_FILENAME = "schema.cedarschema";

export interface SchemaProps {
  /** Human-readable Cedar schema text, emitted verbatim. */
  text: string;
  /** Defaults to {@link CEDAR_SCHEMA_FILENAME}. Must end in `.cedarschema`. */
  filename?: string;
}

/** A `.cedarschema` emitted with the policy set, so post-synth validation has something to validate against. */
export const Schema = createResource(CEDAR_SCHEMA_TYPE, "cedar", {}) as unknown as new (props: SchemaProps) => Declarable;

/** One schema file the serializer should write. */
export interface SchemaFile {
  name: string;
  filename: string;
  text: string;
}

/** Every `Cedar::Schema` in the entity map, with its props read. */
export function schemaEntities(entities: Map<string, Declarable>): SchemaFile[] {
  const files: SchemaFile[] = [];
  for (const [name, entity] of entities) {
    if (isPropertyDeclarable(entity)) continue;
    if (entity.entityType !== CEDAR_SCHEMA_TYPE) continue;
    const props = getProps(entity) as Partial<SchemaProps>;
    if (typeof props.text !== "string") continue;
    files.push({
      name,
      filename: typeof props.filename === "string" ? props.filename : CEDAR_SCHEMA_FILENAME,
      text: props.text.endsWith("\n") ? props.text : props.text + "\n",
    });
  }
  return files;
}

/**
 * The `buildRoots` contribution: the project's resolved schema as one
 * {@link Schema} entity, or nothing when only the bundled default applies.
 */
export async function schemaBuildRoot(ctx: BuildRootContext): Promise<BuildRootContribution> {
  const config = (ctx.config as { cedar?: CedarGenerateConfig }).cedar ?? {};
  const source = resolveSchemaPath({ projectRoot: ctx.projectRoot, config });
  if (source.isDefault) return { entities: new Map() };

  const text = readFileSync(source.path, "utf-8");
  const entity = new Schema({ text, filename: basename(source.path) });
  return { entities: new Map([[CEDAR_SCHEMA_ENTITY_NAME, entity]]) };
}
