import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export function loadSchemaFixtures(): Map<string, Buffer> {
  const schemasDir = join(dirname(fileURLToPath(import.meta.url)), "schemas");
  const schemas = new Map<string, Buffer>();
  for (const file of readdirSync(schemasDir)) {
    if (!file.endsWith(".json")) continue;
    const data = readFileSync(join(schemasDir, file));
    const parsed = JSON.parse(data.toString("utf-8"));
    if (parsed.typeName) {
      schemas.set(parsed.typeName, Buffer.from(data));
    }
  }
  return schemas;
}
