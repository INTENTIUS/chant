import type { LexiconPlugin, ResourceMetadata, ArtifactMetadata } from "../../core/src/lexicon";
import type { Serializer } from "../../core/src/serializer";
import { observation, type UnobservedEntity } from "../../core/src/observation";
import {
  deepObservation,
  type DeepNormalizationHooks,
  type DeepResourceObservation,
} from "../../core/src/deep-observation";
import { createMockSerializer } from "./fixtures";

export interface MockPluginOptions {
  name?: string;
  serializer?: Serializer;
  describeResources?: LexiconPlugin["describeResources"];
  listArtifacts?: LexiconPlugin["listArtifacts"];
  /** Deep observation (#1014) — the property-level reader. */
  observeResourcesDeep?: LexiconPlugin["observeResourcesDeep"];
  /** Deep observation (#1014) — the lexicon's pruning/ordering rules. */
  deepNormalizationHooks?: DeepNormalizationHooks;
}

export function createMockPlugin(options: MockPluginOptions = {}): LexiconPlugin {
  const name = options.name ?? "mock";
  const noop = async () => {};
  return {
    name,
    serializer: options.serializer ?? createMockSerializer(name),
    generate: noop,
    validate: noop,
    coverage: noop,
    package: noop,
    ...(options.describeResources && { describeResources: options.describeResources }),
    ...(options.listArtifacts && { listArtifacts: options.listArtifacts }),
    ...(options.observeResourcesDeep && { observeResourcesDeep: options.observeResourcesDeep }),
    ...(options.deepNormalizationHooks && { deepNormalizationHooks: options.deepNormalizationHooks }),
  };
}

export function staticDescribeResources(
  resources: Record<string, ResourceMetadata>,
): LexiconPlugin["describeResources"] {
  return async () => resources;
}

/**
 * A `describeResources` that reports both halves of the observation tri-state
 * (#1089): what it read, and what it could not. Use it to drive a consumer
 * through the NOT-OBSERVED path.
 */
export function staticObservation(
  resources: Record<string, ResourceMetadata>,
  unobserved?: Record<string, UnobservedEntity>,
): LexiconPlugin["describeResources"] {
  return async () => observation(resources, unobserved);
}

/**
 * An `observeResourcesDeep` that returns fixed property trees, and optionally
 * the entities it could not read. The deep sibling of {@link staticObservation}.
 */
export function staticDeepObservation(
  resources: Record<string, DeepResourceObservation>,
  unobserved?: Record<string, UnobservedEntity>,
): LexiconPlugin["observeResourcesDeep"] {
  return async () => deepObservation(resources, unobserved);
}

export function staticListArtifacts(
  artifacts: Record<string, ArtifactMetadata>,
): LexiconPlugin["listArtifacts"] {
  return async () => artifacts;
}
