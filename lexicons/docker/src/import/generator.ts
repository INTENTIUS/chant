/**
 * Docker IR → TypeScript source generator.
 *
 * Converts parsed IR to valid chant TypeScript source code.
 */

import type { DockerIR, ServiceIR, VolumeIR, NetworkIR, ConfigIR, SecretIR, DockerfileIR } from "./parser";

export interface GenerateResult {
  source: string;
  warnings: string[];
}

/**
 * Generator for Docker entities — IR → TypeScript chant source.
 */
export class DockerGenerator {
  generate(entities: DockerIR[]): GenerateResult {
    const warnings: string[] = [];
    const imports = new Set<string>();
    const lines: string[] = [];
    const names = new ExportNames();

    for (const entity of entities) {
      if (entity.kind === "dockerfile") {
        imports.add("Dockerfile");
        lines.push(generateDockerfile(entity, warnings));
        continue;
      }
      const ctor = CONSTRUCTORS[entity.kind];
      imports.add(ctor);
      const exportName = names.take(entity.name, entity.kind);
      const expr = `new ${ctor}(${propsLiteral(entity)})`;
      // An export name that differs from the compose key would rename the
      // key on build, and every reference to it by name would dangle, so
      // the key is set explicitly (#3937).
      if (exportName === entity.name) {
        lines.push(`export const ${exportName} = ${expr};`);
      } else {
        imports.add("composeKey");
        lines.push(`export const ${exportName} = composeKey(${JSON.stringify(entity.name)}, ${expr});`);
      }
    }

    const importLine = `import { ${[...imports].sort().join(", ")} } from "@intentius/chant-lexicon-docker";`;
    const source = [importLine, "", ...lines].join("\n");

    return { source, warnings };
  }
}

const CONSTRUCTORS = {
  service: "Service",
  volume: "Volume",
  network: "Network",
  config: "DockerConfig",
  secret: "DockerSecret",
} as const;

function propsLiteral(entity: ServiceIR | VolumeIR | NetworkIR | ConfigIR | SecretIR): string {
  if (entity.kind === "service") {
    return JSON.stringify(entity.props, null, 2).replace(/"([a-z_][a-z0-9_]*)":/g, "$1:");
  }
  return Object.keys(entity.props).length > 0 ? JSON.stringify(entity.props) : "{}";
}

/** Words an export cannot be named, and the names the generated file imports. */
const RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import", "in",
  "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try", "typeof",
  "var", "void", "while", "with", "yield", "let", "static", "implements", "interface", "package",
  "private", "protected", "public", "await", "arguments", "eval", "undefined", "NaN", "Infinity",
  "Service", "Volume", "Network", "DockerConfig", "DockerSecret", "Dockerfile", "composeKey",
]);

/**
 * Export names for compose keys: identifiers, unique within the file. A key
 * shared by two kinds (a service and a volume both named `db`) gives the
 * second one a kind suffix (`dbVolume`).
 */
class ExportNames {
  private readonly used = new Set<string>();

  take(key: string, kind: string): string {
    const base = sanitizeName(key);
    const suffixed = `${base}${kind[0]!.toUpperCase()}${kind.slice(1)}`;
    for (const c of [base, suffixed]) {
      if (!RESERVED.has(c) && !this.used.has(c)) {
        this.used.add(c);
        return c;
      }
    }
    for (let i = 2; ; i++) {
      const c = `${suffixed}${i}`;
      if (!this.used.has(c)) {
        this.used.add(c);
        return c;
      }
    }
  }
}

/** The instructions a step can name; anything else (MAINTAINER) is left as a comment. */
const STEP_KEYS = new Set([
  "arg", "env", "workdir", "user", "run", "copy", "add", "expose", "volume",
  "label", "entrypoint", "cmd", "healthcheck", "shell", "stopsignal", "onbuild",
]);

/**
 * A Dockerfile always imports as `steps`, one per instruction in source
 * order, so building the import gives the same instructions in the same
 * order (the per-kind fields would reorder them).
 */
function generateDockerfile(df: DockerfileIR, warnings: string[]): string {
  const out: string[] = [`export const ${sanitizeName(df.name)} = new Dockerfile({`];
  if (df.globalArgs?.length) out.push(`  globalArgs: [${df.globalArgs.map((a) => JSON.stringify(a)).join(", ")}],`);

  const steps = (stage: DockerfileIR["stages"][number], indent: string): void => {
    out.push(`${indent}steps: [`);
    for (const { instruction, value } of stage.instructions) {
      const key = instruction.toLowerCase();
      if (STEP_KEYS.has(key)) {
        out.push(`${indent}  { ${key}: ${quote(value)} },`);
      } else {
        warnings.push(`Dockerfile ${df.name}: ${instruction} has no step and was left as a comment`);
        out.push(`${indent}  // ${instruction} ${value.replace(/\n/g, " ")}`);
      }
    }
    out.push(`${indent}],`);
  };

  if (df.stages.length === 1) {
    const stage = df.stages[0]!;
    out.push(`  from: ${JSON.stringify(stage.from)},`);
    if (stage.as) out.push(`  as: ${JSON.stringify(stage.as)},`);
    steps(stage, "  ");
  } else {
    out.push(`  stages: [`);
    for (const stage of df.stages) {
      out.push(`    {`);
      out.push(`      from: ${JSON.stringify(stage.from)},`);
      if (stage.as) out.push(`      as: ${JSON.stringify(stage.as)},`);
      steps(stage, "      ");
      out.push(`    },`);
    }
    out.push(`  ],`);
  }
  out.push(`});`);
  return out.join("\n");
}

/** A string literal, single-quoted when that avoids escaping double quotes (exec form: `'["node", "a.js"]'`). */
function quote(value: string): string {
  if (value.includes('"') && !/['\\\n]/.test(value)) return `'${value}'`;
  return JSON.stringify(value);
}

/**
 * A TypeScript identifier for a compose key: kebab, snake and dotted keys
 * become camelCase, other characters are dropped, and a leading digit gets
 * an underscore.
 */
function sanitizeName(name: string): string {
  let id = name.replace(/[^A-Za-z0-9$]+([A-Za-z0-9])/g, (_, c: string) => c.toUpperCase());
  id = id.replace(/[^A-Za-z0-9_$]/g, "");
  if (id === "") id = "entity";
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return id;
}
