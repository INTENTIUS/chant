import type { Declarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";

/**
 * The pulumi serializer. The lexicon declares no resource types: a Pulumi
 * program is a workspace member chant reads, not something chant writes. A
 * build that names the lexicon gets an empty document.
 */
export const pulumiSerializer: Serializer = {
  name: "pulumi",
  rulePrefix: "PUL",
  serialize(_entities: Map<string, Declarable>): SerializerResult {
    return { primary: "{}\n", files: {} };
  },
};
