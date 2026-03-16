/**
 * GitHub Actions YAML parser for `chant import`.
 *
 * Parses existing .github/workflows/*.yml files into TemplateIR.
 */

import type { TemplateParser, TemplateIR, ResourceIR } from "@intentius/chant/import/parser";
import { parseYAML } from "@intentius/chant/yaml";

function kebabToCamelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function snakeToCamelCase(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * GitHub Actions YAML parser implementation.
 */
export class GitHubActionsParser implements TemplateParser {
  parse(content: string): TemplateIR {
    const doc = parseYAML(content);
    const resources: ResourceIR[] = [];

    // Extract workflow-level properties
    const workflowProps: Record<string, unknown> = {};
    if (doc.name) workflowProps.name = doc.name;
    if (doc["run-name"]) workflowProps["run-name"] = doc["run-name"];
    if (doc.on) workflowProps.on = doc.on;
    if (doc.permissions) workflowProps.permissions = doc.permissions;
    if (doc.env) workflowProps.env = doc.env;
    if (doc.concurrency) workflowProps.concurrency = doc.concurrency;
    if (doc.defaults) workflowProps.defaults = doc.defaults;

    if (Object.keys(workflowProps).length > 0) {
      resources.push({
        logicalId: "workflow",
        type: "GitHub::Actions::Workflow",
        properties: workflowProps,
      });
    }

    // Extract jobs
    if (doc.jobs && typeof doc.jobs === "object") {
      for (const [jobId, jobDef] of Object.entries(doc.jobs as Record<string, unknown>)) {
        if (typeof jobDef !== "object" || jobDef === null) continue;

        const jobObj = jobDef as Record<string, unknown>;
        const logicalId = kebabToCamelCase(jobId);

        // Determine if it's a reusable workflow call job
        const type = jobObj.uses
          ? "GitHub::Actions::ReusableWorkflowCallJob"
          : "GitHub::Actions::Job";

        resources.push({
          logicalId,
          type,
          properties: jobObj,
          metadata: {
            originalName: jobId,
          },
        });
      }
    }

    return {
      resources,
      parameters: [],
    };
  }
}
