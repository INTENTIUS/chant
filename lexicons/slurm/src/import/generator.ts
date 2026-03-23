/**
 * Slurm import generator — converts SlurmIR entities into TypeScript source.
 *
 * Output is a single TypeScript file with:
 * - import line for the types used
 * - export const declarations for each entity
 */

import type { SlurmIR } from "./parser";

export interface GenerateResult {
  source: string;
  warnings: string[];
}

// ── Name sanitization ──────────────────────────────────────────────

/**
 * Convert a slurm.conf name to a valid TypeScript camelCase identifier.
 * e.g. "gpu_eda" → "gpuEda", "node[001-016]" → "node001016", "hpc-prod" → "hpcProd"
 */
function sanitizeName(name: string): string {
  return name
    .replace(/\[.*?\]/g, "")           // strip bracket ranges
    .replace(/[-_]([a-z0-9])/gi, (_, c: string) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9_$]/g, "")   // strip remaining non-ident chars
    .replace(/^(\d)/, "_$1");          // prefix if starts with digit
}

// ── Entity generators ──────────────────────────────────────────────

function generateEntity(entity: SlurmIR): string {
  const typeName = entityTypeName(entity.kind);
  const varName = sanitizeName(entity.name) || sanitizeName(entity.kind);

  const propsStr = JSON.stringify(entity.props, null, 2)
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g, "$1:");

  return `export const ${varName} = new ${typeName}(${propsStr});`;
}

function entityTypeName(kind: string): string {
  switch (kind) {
    case "cluster":   return "Cluster";
    case "node":      return "Node";
    case "partition": return "Partition";
    case "license":   return "License";
    default:          return kind.charAt(0).toUpperCase() + kind.slice(1);
  }
}

// ── Generator ─────────────────────────────────────────────────────

export class SlurmGenerator {
  generate(entities: SlurmIR[]): GenerateResult {
    const imports = new Set<string>();
    const lines: string[] = [];

    for (const entity of entities) {
      const typeName = entityTypeName(entity.kind);
      imports.add(typeName);
      lines.push(generateEntity(entity));
    }

    if (imports.size === 0) {
      return { source: "// No entities found\n", warnings: [] };
    }

    const sortedImports = [...imports].sort().join(", ");
    const importLine = `import { ${sortedImports} } from "@intentius/chant-lexicon-slurm";`;

    const source = [importLine, "", ...lines].join("\n") + "\n";
    return { source, warnings: [] };
  }
}
