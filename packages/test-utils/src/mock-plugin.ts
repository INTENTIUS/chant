import type { LexiconPlugin, ResourceMetadata, ArtifactMetadata } from "../../core/src/lexicon";
import type { Serializer } from "../../core/src/serializer";
import { createMockSerializer } from "./fixtures";

export interface MockPluginOptions {
  name?: string;
  serializer?: Serializer;
  describeResources?: LexiconPlugin["describeResources"];
  listArtifacts?: LexiconPlugin["listArtifacts"];
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
  };
}

export function staticDescribeResources(
  resources: Record<string, ResourceMetadata>,
): LexiconPlugin["describeResources"] {
  return async () => resources;
}

export function staticListArtifacts(
  artifacts: Record<string, ArtifactMetadata>,
): LexiconPlugin["listArtifacts"] {
  return async () => artifacts;
}
