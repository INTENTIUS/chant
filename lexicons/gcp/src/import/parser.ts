/**
 * Config Connector YAML template parser.
 *
 * Parses Config Connector YAML manifests into the import IR
 * for conversion to chant TypeScript.
 */

import type {
  TemplateParser,
  TemplateIR,
  ResourceIR,
} from "@intentius/chant/import/parser";
import { BaseValueParser } from "@intentius/chant/import/base-parser";
import { parseYAML } from "@intentius/chant/yaml";
import { gcpTypeName } from "../spec/parse";

/**
 * Parser for Config Connector YAML manifests.
 */
export class GcpParser extends BaseValueParser implements TemplateParser {
  protected dispatchIntrinsic(
    _key: string,
    _value: unknown,
    _obj: Record<string, unknown>,
  ): unknown | null {
    // Config Connector YAML has no intrinsic functions
    return null;
  }

  parse(input: string): TemplateIR {
    const resources: ResourceIR[] = [];
    const documents = input
      .split(/^---\s*$/m)
      .map((d) => d.trim())
      .filter((d) => d.length > 0);

    for (const docStr of documents) {
      const doc = parseYAML(docStr) as Record<string, unknown>;
      if (!doc) continue;

      const apiVersion = doc.apiVersion as string | undefined;
      const kind = doc.kind as string | undefined;
      if (!apiVersion || !kind) continue;

      // Only handle Config Connector resources
      if (!apiVersion.includes("cnrm.cloud.google.com")) continue;

      const group = apiVersion.split("/")[0];
      const typeName = gcpTypeName(group, kind);

      const metadata = doc.metadata as Record<string, unknown> | undefined;
      const spec = doc.spec as Record<string, unknown> | undefined;

      const logicalName = (metadata?.name as string) ?? kind;

      // Build properties from spec
      const properties: Record<string, unknown> = {};
      if (metadata) {
        properties.metadata = this.parseValue(metadata);
      }
      if (spec) {
        for (const [key, value] of Object.entries(spec)) {
          properties[key] = this.parseValue(value);
        }
      }

      resources.push({
        logicalName,
        type: typeName,
        properties,
      });
    }

    return {
      resources,
      parameters: [],
      outputs: [],
    };
  }
}
