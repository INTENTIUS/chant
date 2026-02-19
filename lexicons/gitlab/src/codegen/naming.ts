/**
 * GitLab CI naming strategy — simpler than AWS since CI entities
 * use a flat GitLab::CI:: namespace with few collisions.
 */

import {
  NamingStrategy as CoreNamingStrategy,
  type NamingConfig,
  type NamingInput,
} from "@intentius/chant/codegen/naming";
import { gitlabShortName, gitlabServiceName, type GitLabParseResult } from "./parse";

export { propertyTypeName, extractDefName } from "@intentius/chant/codegen/naming";

const gitlabNamingConfig: NamingConfig = {
  priorityNames: {
    "GitLab::CI::Job": "Job",
    "GitLab::CI::Default": "Default",
    "GitLab::CI::Workflow": "Workflow",
    "GitLab::CI::Artifacts": "Artifacts",
    "GitLab::CI::Cache": "Cache",
    "GitLab::CI::Image": "Image",
    "GitLab::CI::Rule": "Rule",
    "GitLab::CI::Retry": "Retry",
    "GitLab::CI::AllowFailure": "AllowFailure",
    "GitLab::CI::Parallel": "Parallel",
    "GitLab::CI::Include": "Include",
    "GitLab::CI::Release": "Release",
    "GitLab::CI::Environment": "Environment",
    "GitLab::CI::Trigger": "Trigger",
    "GitLab::CI::AutoCancel": "AutoCancel",
  },
  priorityAliases: {},
  priorityPropertyAliases: {},
  serviceAbbreviations: {},
  shortName: gitlabShortName,
  serviceName: gitlabServiceName,
};

/**
 * GitLab-specific naming strategy.
 * Extends core NamingStrategy with GitLab naming config.
 */
export class NamingStrategy extends CoreNamingStrategy {
  constructor(results: GitLabParseResult[]) {
    const inputs: NamingInput[] = results.map((r) => ({
      typeName: r.resource.typeName,
      propertyTypes: r.propertyTypes,
    }));
    super(inputs, gitlabNamingConfig);
  }
}
