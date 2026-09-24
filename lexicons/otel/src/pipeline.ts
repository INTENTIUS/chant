/**
 * `Pipeline` and `Service`: the `service:` half of a collector config.
 *
 * A pipeline names its components either by the declared entity, which
 * keeps the reference checked by TypeScript, or by id string (`otlp/backend`)
 * for a component declared somewhere chant can't see. OTEL101 catches a
 * string that names nothing declared.
 */

import { createResource } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import type { OTelComponent } from "./define";
import { componentId, type ComponentKind, type Signal } from "./model";

/** A reference to a component of kind `K`: the declared entity, or its id. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ComponentRef<K extends ComponentKind> = OTelComponent<K, string, any> | string;

export interface PipelineProps {
  signal: Signal;
  /** The instance name. The pipeline id becomes `signal/name`. */
  name?: string;
  receivers: ComponentRef<"receiver">[];
  processors?: ComponentRef<"processor">[];
  exporters: ComponentRef<"exporter">[];
}

export interface PipelineEntity extends Declarable {
  readonly props: PipelineProps;
  /** The pipeline id under `service.pipelines`, `signal` or `signal/name`. */
  readonly pipelineId: string;
}

export const PIPELINE_TYPE = "OTel::Pipeline";
export const SERVICE_TYPE = "OTel::Service";

const PipelineBase = createResource(PIPELINE_TYPE, "otel", {}) as unknown as (this: object, props: Record<string, unknown>) => void;

/** One entry under `service.pipelines`. */
export const Pipeline = function (this: object, props: PipelineProps) {
  PipelineBase.call(this, props as unknown as Record<string, unknown>);
  Object.defineProperty(this, "pipelineId", { value: componentId(props.signal, props.name), enumerable: false });
} as unknown as new (props: PipelineProps) => PipelineEntity;
Object.defineProperty(Pipeline, "name", { value: "Pipeline" });

export interface ServiceTelemetry {
  logs?: {
    level?: "debug" | "info" | "warn" | "error";
    encoding?: "console" | "json";
    development?: boolean;
    output_paths?: string[];
    error_output_paths?: string[];
    initial_fields?: Record<string, string>;
    sampling?: Record<string, unknown>;
  };
  metrics?: {
    level?: "none" | "basic" | "normal" | "detailed";
    readers?: Array<Record<string, unknown>>;
  };
  traces?: {
    processors?: Array<Record<string, unknown>>;
    propagators?: string[];
  };
  resource?: Record<string, string>;
}

export interface ServiceProps {
  /**
   * Extensions to enable, in start order. Leave it out and every declared
   * extension is enabled in declaration order.
   */
  extensions?: ComponentRef<"extension">[];
  telemetry?: ServiceTelemetry;
}

export interface ServiceEntity extends Declarable {
  readonly props: ServiceProps;
}

/** `service.extensions` and `service.telemetry`. Optional; declare at most one. */
export const Service = createResource(SERVICE_TYPE, "otel", {}) as unknown as new (props: ServiceProps) => ServiceEntity;

export function isPipelineEntity(value: unknown): value is PipelineEntity {
  return typeof value === "object" && value !== null && (value as Declarable).entityType === PIPELINE_TYPE;
}

export function isServiceEntity(value: unknown): value is ServiceEntity {
  return typeof value === "object" && value !== null && (value as Declarable).entityType === SERVICE_TYPE;
}
