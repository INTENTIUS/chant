/**
 * GitHub Actions predefined context variable references.
 *
 * These provide type-safe access to GitHub and Runner context values
 * that expand to `${{ context.property }}` expressions in YAML.
 */

import { Expression } from "./expression";

export const GitHub = {
  Ref: /* @__PURE__ */ new Expression("github.ref"),
  RefName: /* @__PURE__ */ new Expression("github.ref_name"),
  RefType: /* @__PURE__ */ new Expression("github.ref_type"),
  Sha: /* @__PURE__ */ new Expression("github.sha"),
  Actor: /* @__PURE__ */ new Expression("github.actor"),
  TriggeringActor: /* @__PURE__ */ new Expression("github.triggering_actor"),
  Repository: /* @__PURE__ */ new Expression("github.repository"),
  RepositoryOwner: /* @__PURE__ */ new Expression("github.repository_owner"),
  EventName: /* @__PURE__ */ new Expression("github.event_name"),
  Event: /* @__PURE__ */ new Expression("github.event"),
  RunId: /* @__PURE__ */ new Expression("github.run_id"),
  RunNumber: /* @__PURE__ */ new Expression("github.run_number"),
  RunAttempt: /* @__PURE__ */ new Expression("github.run_attempt"),
  Workflow: /* @__PURE__ */ new Expression("github.workflow"),
  WorkflowRef: /* @__PURE__ */ new Expression("github.workflow_ref"),
  Workspace: /* @__PURE__ */ new Expression("github.workspace"),
  Token: /* @__PURE__ */ new Expression("github.token"),
  Job: /* @__PURE__ */ new Expression("github.job"),
  HeadRef: /* @__PURE__ */ new Expression("github.head_ref"),
  BaseRef: /* @__PURE__ */ new Expression("github.base_ref"),
  ServerUrl: /* @__PURE__ */ new Expression("github.server_url"),
  ApiUrl: /* @__PURE__ */ new Expression("github.api_url"),
  GraphqlUrl: /* @__PURE__ */ new Expression("github.graphql_url"),
  Action: /* @__PURE__ */ new Expression("github.action"),
  ActionPath: /* @__PURE__ */ new Expression("github.action_path"),
} as const;

export const Runner = {
  Os: /* @__PURE__ */ new Expression("runner.os"),
  Arch: /* @__PURE__ */ new Expression("runner.arch"),
  Name: /* @__PURE__ */ new Expression("runner.name"),
  Temp: /* @__PURE__ */ new Expression("runner.temp"),
  ToolCache: /* @__PURE__ */ new Expression("runner.tool_cache"),
} as const;
