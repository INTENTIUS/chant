/**
 * Temporal lexicon resources — hand-written Declarable constructors.
 *
 * These model the Temporal.io infrastructure concerns that chant serializes:
 * server deployment configs, namespace provisioning scripts, search attribute
 * registration, and SDK schedule creation code.
 *
 * All 4 resources are hand-written (no upstream spec to generate from).
 *
 * Reference: https://docs.temporal.io
 */

import { createResource } from "@intentius/chant/runtime";

// ── TemporalServer ────────────────────────────────────────────────────
// Serializes to docker-compose.yml (primary) and temporal-helm-values.yaml.
// mode: "dev" emits a single-container dev server via `temporal server start-dev`.
// mode: "full" emits auto-setup + postgresql + UI services.

export const TemporalServer = createResource("Temporal::Server", "temporal", {});

export interface TemporalServerProps {
  /** Temporal server version tag. Default: "1.26.2" */
  version?: string;
  /** Deployment mode. Default: "dev" */
  mode?: "dev" | "full";
  /** gRPC port. Default: 7233 */
  port?: number;
  /** Web UI port. Default: 8080 */
  uiPort?: number;
  /** PostgreSQL image tag for "full" mode. Default: "16-alpine" */
  postgresVersion?: string;
  /** Helm chart version hint — written as a comment in helm-values.yaml */
  helmChartVersion?: string;
}

// ── TemporalNamespace ─────────────────────────────────────────────────
// Serializes to temporal-setup.sh as `temporal operator namespace create` commands.

export const TemporalNamespace = createResource("Temporal::Namespace", "temporal", {});

export interface TemporalNamespaceProps {
  /** Namespace name */
  name: string;
  /** Workflow execution retention period. Default: "7d" */
  retention?: string;
  /** Human-readable description */
  description?: string;
  /** Whether this is a global (multi-cluster) namespace */
  isGlobalNamespace?: boolean;
}

// ── SearchAttribute ───────────────────────────────────────────────────
// Serializes to temporal-setup.sh as `temporal operator search-attribute create` commands.

export const SearchAttribute = createResource("Temporal::SearchAttribute", "temporal", {});

export interface SearchAttributeProps {
  /** Attribute name (PascalCase recommended by Temporal) */
  name: string;
  /** Attribute value type */
  type: "Text" | "Keyword" | "Int" | "Double" | "Bool" | "Datetime" | "KeywordList";
  /** Namespace to register in. If omitted, --namespace flag is not emitted */
  namespace?: string;
}

// ── TemporalSchedule ──────────────────────────────────────────────────
// Serializes to schedules/<scheduleId>.ts — runnable TypeScript that creates
// the schedule via the Temporal SDK client.

export const TemporalSchedule = createResource("Temporal::Schedule", "temporal", {});

export interface TemporalScheduleProps {
  /** Unique schedule identifier */
  scheduleId: string;
  /** Schedule timing specification */
  spec: {
    /** Cron expressions (e.g. "0 9 * * MON-FRI") */
    cronExpressions?: string[];
    /** Fixed intervals (e.g. { every: "1d" }) */
    intervals?: Array<{ every: string; offset?: string }>;
  };
  /** What workflow to start */
  action: {
    workflowType: string;
    taskQueue: string;
    args?: unknown[];
    workflowExecutionTimeout?: string;
    workflowRunTimeout?: string;
    memo?: Record<string, unknown>;
    searchAttributes?: Record<string, unknown>;
    /**
     * Retry policy for the triggered workflow execution.
     * When set, the generated schedule script includes `workflowStartOptions.retry`.
     */
    workflowRetryPolicy?: {
      /** Initial retry interval (e.g. "10s"). Default: Temporal server default (~1s). */
      initialInterval?: string;
      /** Backoff multiplier for each subsequent retry (e.g. 2). */
      backoffCoefficient?: number;
      /** 0 = unlimited retries; defaults to Temporal server default (unlimited). */
      maximumAttempts?: number;
      /** Cap on retry intervals (e.g. "5m"). */
      maximumInterval?: string;
      /** Error types that should NOT trigger a retry. */
      nonRetryableErrorTypes?: string[];
    };
  };
  policies?: {
    overlap?: "Skip" | "BufferOne" | "BufferAll" | "CancelOther" | "TerminateOther" | "AllowAll";
    catchupWindow?: string;
    pauseOnFailure?: boolean;
  };
  /** Initial paused state */
  state?: {
    paused?: boolean;
    note?: string;
  };
  /** Namespace to create schedule in. Default: process.env.TEMPORAL_NAMESPACE ?? "default" */
  namespace?: string;
}
