/**
 * The seam between the cedar-shaped parser/generator above and the core
 * `TemplateParser` / `TypeScriptGenerator` that `chant import` drives.
 *
 * Core's pipeline speaks `TemplateIR` — a flat list of `ResourceIR` with a
 * `type` string it may reorganize into category files. A Cedar policy maps
 * cleanly onto one: the logical id is the policy id, and the type records
 * whether Cedar read it as a static policy or as a template, so the mapping
 * reverses without guessing.
 */

import type { TemplateIR, TemplateParser, ResourceIR } from "@intentius/chant/import/parser";
import type { GeneratedFile, TypeScriptGenerator } from "@intentius/chant/import/generator";
import { CedarParser, type CedarEntityKind, type CedarPolicyIR } from "./parser";
import { CedarGenerator, loadActionConstants } from "./generator";

/** The `ResourceIR.type` each IR kind is filed under. */
const TYPE_BY_KIND: Record<CedarEntityKind, string> = {
  policy: "Cedar::Policy",
  template: "Cedar::Template",
};

const KIND_BY_TYPE: Record<string, CedarEntityKind> = {
  "Cedar::Policy": "policy",
  "Cedar::Template": "template",
};

function toResource(entity: CedarPolicyIR): ResourceIR {
  return {
    logicalId: entity.name,
    type: TYPE_BY_KIND[entity.kind],
    properties: entity.props,
  };
}

function toPolicyIR(resource: ResourceIR): CedarPolicyIR {
  return {
    kind: KIND_BY_TYPE[resource.type] ?? "policy",
    name: resource.logicalId,
    props: resource.properties,
  };
}

/** `TemplateParser` over `.cedar` text and the JSON policy-set envelope. */
export class CedarTemplateParser implements TemplateParser {
  parse(content: string): TemplateIR {
    const { entities, warnings } = new CedarParser().parse(content);
    return {
      resources: entities.map(toResource),
      parameters: [],
      ...(warnings.length > 0 ? { metadata: { warnings } } : {}),
    };
  }
}

/** `TypeScriptGenerator` emitting `new Policy({ … })` per imported policy. */
export class CedarTemplateGenerator implements TypeScriptGenerator {
  generate(ir: TemplateIR): GeneratedFile[] {
    const generator = new CedarGenerator({ actionConstants: loadActionConstants() });
    const { source } = generator.generate(ir.resources.map(toPolicyIR));
    return [{ path: "main.ts", content: source }];
  }
}
