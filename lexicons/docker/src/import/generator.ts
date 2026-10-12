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

    for (const entity of entities) {
      switch (entity.kind) {
        case "service":
          imports.add("Service");
          lines.push(generateService(entity));
          break;
        case "volume":
          imports.add("Volume");
          lines.push(generateVolume(entity));
          break;
        case "network":
          imports.add("Network");
          lines.push(generateNetwork(entity));
          break;
        case "config":
          imports.add("Config");
          lines.push(generateConfig(entity));
          break;
        case "secret":
          imports.add("Secret");
          lines.push(generateSecret(entity));
          break;
        case "dockerfile":
          imports.add("Dockerfile");
          lines.push(generateDockerfile(entity, warnings));
          break;
      }
    }

    const importLine = `import { ${[...imports].sort().join(", ")} } from "@intentius/chant-lexicon-docker";`;
    const source = [importLine, "", ...lines].join("\n");

    return { source, warnings };
  }
}

function generateService(svc: ServiceIR): string {
  const propsStr = JSON.stringify(svc.props, null, 2)
    .replace(/"([a-z_][a-z0-9_]*)":/g, "$1:");
  return `export const ${sanitizeName(svc.name)} = new Service(${propsStr});`;
}

function generateVolume(vol: VolumeIR): string {
  const hasProps = Object.keys(vol.props).length > 0;
  return `export const ${sanitizeName(vol.name)} = new Volume(${hasProps ? JSON.stringify(vol.props) : "{}"});`;
}

function generateNetwork(net: NetworkIR): string {
  const hasProps = Object.keys(net.props).length > 0;
  return `export const ${sanitizeName(net.name)} = new Network(${hasProps ? JSON.stringify(net.props) : "{}"});`;
}

function generateConfig(cfg: ConfigIR): string {
  const hasProps = Object.keys(cfg.props).length > 0;
  return `export const ${sanitizeName(cfg.name)} = new Config(${hasProps ? JSON.stringify(cfg.props) : "{}"});`;
}

function generateSecret(sec: SecretIR): string {
  const hasProps = Object.keys(sec.props).length > 0;
  return `export const ${sanitizeName(sec.name)} = new Secret(${hasProps ? JSON.stringify(sec.props) : "{}"});`;
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
        out.push(`${indent}  { ${key}: ${JSON.stringify(value)} },`);
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

function sanitizeName(name: string): string {
  // Convert kebab/snake to camelCase
  return name.replace(/[-_]([a-z])/g, (_, c) => c.toUpperCase());
}
