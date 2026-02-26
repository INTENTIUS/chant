/**
 * Helm chart parser for `chant import`.
 *
 * Parses an existing Helm chart directory (Chart.yaml, values.yaml, templates/)
 * into the core TemplateIR format, preserving Go template expressions as metadata
 * for reconstruction as Helm intrinsics.
 */

import type { TemplateParser, TemplateIR, ResourceIR, ParameterIR } from "@intentius/chant/import/parser";
import { parseYAML } from "@intentius/chant/yaml";
import { stripTemplateExpressions, classifyExpression } from "./template-stripper";

/**
 * Helm chart parser.
 *
 * Input: a map of file paths to contents (as would be read from a chart directory).
 * The parse() method accepts the contents as a JSON-encoded map.
 */
export class HelmParser implements TemplateParser {
  parse(content: string): TemplateIR {
    // Content is a JSON map of { "path": "content" }
    const files: Record<string, string> = JSON.parse(content);
    return this.parseFiles(files);
  }

  parseFiles(files: Record<string, string>): TemplateIR {
    const resources: ResourceIR[] = [];
    const parameters: ParameterIR[] = [];

    // Parse Chart.yaml
    const chartYaml = files["Chart.yaml"];
    if (chartYaml) {
      const chartData = parseYAML(chartYaml) as Record<string, unknown>;
      resources.push({
        logicalId: "chart",
        type: "Helm::Chart",
        properties: chartData,
        metadata: { file: "Chart.yaml" },
      });
    }

    // Parse values.yaml → extract parameters
    const valuesYaml = files["values.yaml"];
    if (valuesYaml) {
      const valuesData = parseYAML(valuesYaml) as Record<string, unknown>;
      if (valuesData && typeof valuesData === "object") {
        resources.push({
          logicalId: "valuesSchema",
          type: "Helm::Values",
          properties: valuesData,
          metadata: { file: "values.yaml" },
        });

        // Flatten values into parameters
        this.extractParameters(valuesData, "", parameters);
      }
    }

    // Parse templates
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith("templates/")) continue;
      if (path.endsWith("_helpers.tpl")) continue;
      if (path.endsWith("NOTES.txt")) {
        resources.push({
          logicalId: "notes",
          type: "Helm::Notes",
          properties: { content },
          metadata: { file: path },
        });
        continue;
      }

      this.parseTemplate(path, content, resources);
    }

    return {
      resources,
      parameters,
      metadata: {
        chartName: (resources.find((r) => r.type === "Helm::Chart")?.properties?.name as string) ?? "unknown",
      },
    };
  }

  private parseTemplate(path: string, content: string, resources: ResourceIR[]): void {
    const stripped = stripTemplateExpressions(content);
    const parsed = parseYAML(stripped.yaml);

    if (!parsed || typeof parsed !== "object") return;

    const doc = parsed as Record<string, unknown>;
    const apiVersion = doc.apiVersion as string | undefined;
    const kind = doc.kind as string | undefined;

    if (!apiVersion || !kind) return;

    // Derive a logical ID from the file path
    const fileName = path.replace("templates/", "").replace(/\.yaml$/, "").replace(/[/\\-]/g, "_");
    const logicalId = kind.charAt(0).toLowerCase() + kind.slice(1) + capitalize(fileName);

    // Restore template expressions as metadata
    const templateExpressions: Record<string, { expression: string; kind: string }> = {};
    for (const [placeholder, expr] of stripped.expressions) {
      templateExpressions[placeholder] = {
        expression: expr.expression,
        kind: classifyExpression(expr.expression),
      };
    }

    // Extract properties (skip apiVersion/kind)
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(doc)) {
      if (key === "apiVersion" || key === "kind") continue;
      properties[key] = value;
    }

    resources.push({
      logicalId,
      type: `K8s::${resolveGroup(apiVersion)}::${kind}`,
      properties,
      metadata: {
        file: path,
        apiVersion,
        kind,
        templateExpressions,
        blockDirectives: stripped.blockDirectives,
      },
    });
  }

  private extractParameters(
    obj: Record<string, unknown>,
    prefix: string,
    params: ParameterIR[],
  ): void {
    for (const [key, value] of Object.entries(obj)) {
      const fullPath = prefix ? `${prefix}.${key}` : key;

      if (value && typeof value === "object" && !Array.isArray(value)) {
        this.extractParameters(value as Record<string, unknown>, fullPath, params);
      } else {
        params.push({
          name: fullPath,
          type: Array.isArray(value) ? "array" : typeof value,
          defaultValue: value,
        });
      }
    }
  }
}

function resolveGroup(apiVersion: string): string {
  if (!apiVersion.includes("/")) return "Core";
  const group = apiVersion.split("/")[0].split(".")[0];
  return group.charAt(0).toUpperCase() + group.slice(1);
}

function capitalize(s: string): string {
  return s.split(/[_-]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}
