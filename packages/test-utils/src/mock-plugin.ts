import type { LexiconPlugin, ResourceMetadata } from "@intentius/chant";
import type { Serializer } from "@intentius/chant";
import { createMockSerializer } from "./fixtures";

export interface MockPluginOptions {
  name?: string;
  serializer?: Serializer;
  describeResources?: LexiconPlugin["describeResources"];
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
  };
}

export function staticDescribeResources(
  resources: Record<string, ResourceMetadata>,
): LexiconPlugin["describeResources"] {
  return async () => resources;
}
