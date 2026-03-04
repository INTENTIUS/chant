/**
 * GitHub Actions predefined context variable references.
 *
 * These provide type-safe access to GitHub and Runner context values
 * that expand to `${{ context.property }}` expressions in YAML.
 */

import { Expression } from "./expression";

export const GitHub = {
  Ref: new Expression("github.ref"),
  RefName: new Expression("github.ref_name"),
  RefType: new Expression("github.ref_type"),
  Sha: new Expression("github.sha"),
  Actor: new Expression("github.actor"),
  TriggeringActor: new Expression("github.triggering_actor"),
  Repository: new Expression("github.repository"),
  RepositoryOwner: new Expression("github.repository_owner"),
  EventName: new Expression("github.event_name"),
  Event: new Expression("github.event"),
  RunId: new Expression("github.run_id"),
  RunNumber: new Expression("github.run_number"),
  RunAttempt: new Expression("github.run_attempt"),
  Workflow: new Expression("github.workflow"),
  WorkflowRef: new Expression("github.workflow_ref"),
  Workspace: new Expression("github.workspace"),
  Token: new Expression("github.token"),
  Job: new Expression("github.job"),
  HeadRef: new Expression("github.head_ref"),
  BaseRef: new Expression("github.base_ref"),
  ServerUrl: new Expression("github.server_url"),
  ApiUrl: new Expression("github.api_url"),
  GraphqlUrl: new Expression("github.graphql_url"),
  Action: new Expression("github.action"),
  ActionPath: new Expression("github.action_path"),
} as const;

export const Runner = {
  Os: new Expression("runner.os"),
  Arch: new Expression("runner.arch"),
  Name: new Expression("runner.name"),
  Temp: new Expression("runner.temp"),
  ToolCache: new Expression("runner.tool_cache"),
} as const;
