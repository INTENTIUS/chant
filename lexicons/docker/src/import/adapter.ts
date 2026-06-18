/**
 * Adapters bridging the docker-specific DockerParser/DockerGenerator
 * (which speak DockerIR / ParseResult / GenerateResult) to the core
 * TemplateParser / TypeScriptGenerator interfaces consumed by
 * `chant import` (packages/core/src/cli/commands/import.ts).
 *
 * The core import pipeline parses content into a TemplateIR (a flat list of
 * ResourceIR), optionally organizes resources into category files, then asks
 * the generator to emit GeneratedFile[]. We map each DockerIR to a ResourceIR
 * keyed by its `kind` (service/volume/network/config/secret/dockerfile) and
 * reverse the mapping in the generator so DockerGenerator can do the real work.
 */

import type { TemplateIR, TemplateParser, ResourceIR } from "@intentius/chant/import/parser";
import type { GeneratedFile, TypeScriptGenerator } from "@intentius/chant/import/generator";
import { DockerParser } from "./parser";
import type { DockerIR, DockerfileStage } from "./parser";
import { DockerGenerator } from "./generator";

/** Convert a DockerIR into the core ResourceIR shape. */
function dockerIrToResource(entity: DockerIR): ResourceIR {
  if (entity.kind === "dockerfile") {
    return {
      logicalId: entity.name,
      type: entity.kind,
      properties: { stages: entity.stages },
    };
  }
  return {
    logicalId: entity.name,
    type: entity.kind,
    properties: entity.props,
  };
}

/** Convert a core ResourceIR back into a DockerIR for DockerGenerator. */
function resourceToDockerIr(resource: ResourceIR): DockerIR {
  const name = resource.logicalId;
  switch (resource.type) {
    case "dockerfile":
      return {
        kind: "dockerfile",
        name,
        stages: (resource.properties.stages as DockerfileStage[] | undefined) ?? [],
      };
    case "service":
    case "volume":
    case "network":
    case "config":
    case "secret":
      return {
        kind: resource.type,
        name,
        props: resource.properties,
      };
    default:
      // Unknown types from upstream organization are treated as services so
      // they still round-trip rather than being silently dropped.
      return { kind: "service", name, props: resource.properties };
  }
}

/**
 * TemplateParser adapter — wraps DockerParser.parse and maps its DockerIR
 * entities to a TemplateIR.
 */
export class DockerTemplateParser implements TemplateParser {
  parse(content: string): TemplateIR {
    const { entities } = new DockerParser().parse(content);
    return {
      resources: entities.map(dockerIrToResource),
      parameters: [],
    };
  }
}

/**
 * TypeScriptGenerator adapter — converts a TemplateIR back into DockerIR[]
 * and delegates to DockerGenerator, returning a single generated file.
 */
export class DockerTemplateGenerator implements TypeScriptGenerator {
  generate(ir: TemplateIR): GeneratedFile[] {
    const entities = ir.resources.map(resourceToDockerIr);
    const { source } = new DockerGenerator().generate(entities);
    return [{ path: "main.ts", content: source }];
  }
}
