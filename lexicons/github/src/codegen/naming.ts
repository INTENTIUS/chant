/**
 * GitHub Actions naming strategy — flat namespace with few collisions.
 */

import {
  NamingStrategy as CoreNamingStrategy,
  type NamingConfig,
  type NamingInput,
} from "@intentius/chant/codegen/naming";
import { githubShortName, githubServiceName, type GitHubParseResult } from "./parse";

export { propertyTypeName, extractDefName } from "@intentius/chant/codegen/naming";

const githubNamingConfig: NamingConfig = {
  priorityNames: {
    "GitHub::Actions::Workflow": "Workflow",
    "GitHub::Actions::Job": "Job",
    "GitHub::Actions::ReusableWorkflowCallJob": "ReusableWorkflowCallJob",
    "GitHub::Actions::Step": "Step",
    "GitHub::Actions::Strategy": "Strategy",
    "GitHub::Actions::Permissions": "Permissions",
    "GitHub::Actions::Concurrency": "Concurrency",
    "GitHub::Actions::Container": "Container",
    "GitHub::Actions::Service": "Service",
    "GitHub::Actions::Environment": "Environment",
    "GitHub::Actions::Defaults": "Defaults",
    "GitHub::Actions::PushTrigger": "PushTrigger",
    "GitHub::Actions::PullRequestTrigger": "PullRequestTrigger",
    "GitHub::Actions::PullRequestTargetTrigger": "PullRequestTargetTrigger",
    "GitHub::Actions::ScheduleTrigger": "ScheduleTrigger",
    "GitHub::Actions::WorkflowDispatchTrigger": "WorkflowDispatchTrigger",
    "GitHub::Actions::WorkflowCallTrigger": "WorkflowCallTrigger",
    "GitHub::Actions::WorkflowRunTrigger": "WorkflowRunTrigger",
    "GitHub::Actions::RepositoryDispatchTrigger": "RepositoryDispatchTrigger",
    "GitHub::Actions::WorkflowInput": "WorkflowInput",
    "GitHub::Actions::WorkflowOutput": "WorkflowOutput",
    "GitHub::Actions::WorkflowSecret": "WorkflowSecret",
  },
  priorityAliases: {},
  priorityPropertyAliases: {},
  serviceAbbreviations: {},
  shortName: githubShortName,
  serviceName: githubServiceName,
};

/**
 * GitHub Actions naming strategy.
 */
export class NamingStrategy extends CoreNamingStrategy {
  constructor(results: GitHubParseResult[]) {
    const inputs: NamingInput[] = results.map((r) => ({
      typeName: r.resource.typeName,
      propertyTypes: r.propertyTypes,
    }));
    super(inputs, githubNamingConfig);
  }
}
