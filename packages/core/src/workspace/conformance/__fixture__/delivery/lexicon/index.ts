/**
 * A lexicon of one resource and one composite, declared by path in
 * chant.config.ts, so the reader conformance workspace (#2679) has a
 * composite instance without installing a lexicon package.
 */
import { Composite, createResource } from "@intentius/chant";

export const Service = createResource("Fixture::Service", "fixture", {});

export const WebService = Composite<{ port: number }>((props) => {
  const service = new Service({ port: props.port });
  return { service };
}, "WebService");

export const fixturePlugin = {
  name: "fixture",
  serializer: {
    name: "fixture",
    rulePrefix: "FIX",
    serialize: (entities: Map<string, unknown>) => JSON.stringify(Array.from(entities.keys()).sort()),
  },
  generate: async () => {},
  validate: async () => {},
  coverage: async () => {},
  package: async () => {},
};
