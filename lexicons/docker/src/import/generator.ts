/**
 * Docker IR → TypeScript source generator.
 *
 * Converts parsed IR to valid chant TypeScript source code.
 */

import type { DockerIR, ServiceIR, VolumeIR, NetworkIR, DockerfileIR } from "./parser";

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
        case "dockerfile":
          imports.add("Dockerfile");
          lines.push(generateDockerfile(entity));
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

function generateDockerfile(df: DockerfileIR): string {
  const props: Record<string, unknown> = {};
  if (df.from) props.from = df.from;

  // Group instructions by type
  const grouped: Record<string, string[]> = {};
  for (const { instruction, value } of df.instructions) {
    const key = instruction.toLowerCase();
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(value);
  }

  // Single-value instructions
  for (const single of ["workdir", "user", "entrypoint", "cmd", "healthcheck"]) {
    if (grouped[single]?.length === 1) {
      props[single] = grouped[single][0];
    }
  }

  // Multi-value instructions
  for (const multi of ["run", "copy", "add", "env", "arg", "expose", "volume", "label"]) {
    if (grouped[multi]?.length) {
      props[multi] = grouped[multi].length === 1 ? grouped[multi] : grouped[multi];
    }
  }

  const propsStr = JSON.stringify(props, null, 2).replace(/"([a-z_][a-z0-9_]*)":/g, "$1:");
  return `export const ${sanitizeName(df.name)} = new Dockerfile(${propsStr});`;
}

function sanitizeName(name: string): string {
  // Convert kebab/snake to camelCase
  return name.replace(/[-_]([a-z])/g, (_, c) => c.toUpperCase());
}
