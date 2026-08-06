/**
 * Test fixture loader for the k3d lexicon.
 *
 * The fixture is a verbatim copy of the pinned upstream schema
 * (see src/spec/fetch.ts for the pin), committed so codegen tests
 * run offline.
 */

import { readFileSync } from "fs";
import { join } from "path";

/**
 * Load the pinned SimpleConfig schema fixture for offline testing.
 */
export function loadSchemaFixture(): Buffer {
  const fixturePath = join(import.meta.dirname, "k3d-schema-fixture.json");
  return Buffer.from(readFileSync(fixturePath));
}

/**
 * Load the schema fixture as a Map compatible with generatePipeline.
 */
export function loadSchemaFixtureMap(): Map<string, Buffer> {
  const schemas = new Map<string, Buffer>();
  schemas.set("K3d::Cluster", loadSchemaFixture());
  return schemas;
}
