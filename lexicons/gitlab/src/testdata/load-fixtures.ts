/**
 * Test fixture loader for the GitLab CI lexicon.
 */

import { readFileSync } from "fs";
import { join } from "path";

/**
 * Load the minimal CI schema fixture for offline testing.
 */
export function loadSchemaFixture(): Buffer {
  const fixturePath = join(import.meta.dir, "ci-schema-fixture.json");
  return Buffer.from(readFileSync(fixturePath));
}

/**
 * Load the schema fixture as a Map compatible with generatePipeline.
 */
export function loadSchemaFixtureMap(): Map<string, Buffer> {
  const schemas = new Map<string, Buffer>();
  schemas.set("GitLab::CI::Pipeline", loadSchemaFixture());
  return schemas;
}
