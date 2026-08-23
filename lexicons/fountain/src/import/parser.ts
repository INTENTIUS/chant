/**
 * Fountain template parser.
 *
 * Turns fountain manifests (the `fountain apply -f` YAML, single or
 * multi-document) or the serializer's fountain-plan.json into the import IR
 * for conversion to chant TypeScript. Server-written read-only fields are
 * dropped so the IR is the declared shape. `logicalId` is `metadata.name`
 * (manifests) or the plan's entity name.
 */

import type { TemplateParser, TemplateIR, ResourceIR } from "@intentius/chant/import/parser";
import { BaseValueParser } from "@intentius/chant/import/base-parser";
import { parseYAML } from "@intentius/chant/yaml";
import { isFountainPlan } from "../detect";

/** Server-written read-only fields — never part of the authored shape. */
export const SERVER_FIELDS = ["id", "inserted_at", "updated_at", "user_id", "conversation_count", "avatar_media_type"];

const KIND_TO_TYPE: Record<string, string> = {
  Environment: "Fountain::V1::Environment",
  Vault: "Fountain::V1::Vault",
  Agent: "Fountain::V1::Agent",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class FountainParser extends BaseValueParser implements TemplateParser {
  protected dispatchIntrinsic(): unknown | null {
    // fountain manifests have no intrinsic functions; `${VAR}` substitution
    // is fountain's own runtime concern and passes through as a string.
    return null;
  }

  parse(input: string): TemplateIR {
    const trimmed = input.trim();
    if (!trimmed) return { resources: [], parameters: [] };

    // fountain-plan.json
    if (trimmed.startsWith("{")) {
      try {
        const data = JSON.parse(trimmed) as unknown;
        if (isFountainPlan(data)) {
          const resources: ResourceIR[] = [];
          for (const [entityName, entry] of Object.entries(data as Record<string, { kind: string; spec: Record<string, unknown> }>)) {
            const type = KIND_TO_TYPE[entry.kind];
            if (!type) continue;
            resources.push(this.resource(type, entityName, entry.spec));
          }
          return { resources, parameters: [] };
        }
      } catch {
        // fall through to YAML
      }
    }

    // Manifest YAML (single or multi-document).
    const resources: ResourceIR[] = [];
    for (const docText of trimmed.split(/^---\s*$/m)) {
      if (!docText.trim()) continue;
      const doc = parseYAML(docText);
      const kind = typeof doc.kind === "string" ? doc.kind : "";
      const type = KIND_TO_TYPE[kind];
      if (!type) continue;
      const meta = isRecord(doc.metadata) ? doc.metadata : {};
      const name = typeof meta.name === "string" ? meta.name : kind.toLowerCase();
      const spec = isRecord(doc.spec) ? doc.spec : {};
      // Manifests carry the name in `metadata` only; the typed resource
      // needs it as its `name` prop.
      resources.push(this.resource(type, name, { ...spec, name }));
    }
    return { resources, parameters: [] };
  }

  private resource(type: string, logicalId: string, spec: Record<string, unknown>): ResourceIR {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(spec)) {
      if (SERVER_FIELDS.includes(key)) continue;
      if (value === undefined) continue;
      properties[key] = this.parseValue(value);
    }
    return { logicalId, type, properties };
  }
}
