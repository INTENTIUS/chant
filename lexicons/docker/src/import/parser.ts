/**
 * Docker Compose + Dockerfile parser — converts existing YAML/Dockerfiles
 * to an intermediate representation (IR) for TypeScript code generation.
 */

export interface ServiceIR {
  kind: "service";
  name: string;
  props: Record<string, unknown>;
}

export interface VolumeIR {
  kind: "volume";
  name: string;
  props: Record<string, unknown>;
}

export interface NetworkIR {
  kind: "network";
  name: string;
  props: Record<string, unknown>;
}

export interface DockerfileIR {
  kind: "dockerfile";
  name: string;
  from?: string;
  instructions: Array<{ instruction: string; value: string }>;
}

export type DockerIR = ServiceIR | VolumeIR | NetworkIR | DockerfileIR;

export interface ParseResult {
  entities: DockerIR[];
  warnings: string[];
}

/**
 * Parser for docker-compose.yml files.
 * Converts YAML to an IR consumable by the TypeScript generator.
 */
export class DockerParser {
  parse(content: string): ParseResult {
    const entities: DockerIR[] = [];
    const warnings: string[] = [];

    // Simple regex-based YAML parser for the basic structure
    // A full implementation would use a YAML library
    const servicesIdx = content.search(/^services:\s*$/m);
    if (servicesIdx !== -1) {
      const afterServicesNewline = content.indexOf("\n", servicesIdx);
      const afterServices = afterServicesNewline !== -1 ? content.slice(afterServicesNewline + 1) : "";
      // Take until next top-level (non-indented) key
      const nextTopLevel = afterServices.search(/^[a-z]/m);
      const servicesContent = nextTopLevel !== -1 ? afterServices.slice(0, nextTopLevel) : afterServices;
      const sections = servicesContent.split(/\n(?=  [a-z][a-z0-9_-]*:)/);
      for (const section of sections) {
        const nameMatch = section.match(/^\s{2}([a-z][a-z0-9_-]*):/);
        if (!nameMatch) continue;
        const name = nameMatch[1];
        const imageMatch = section.match(/^\s{4}image:\s+(.+)$/m);
        entities.push({
          kind: "service",
          name,
          props: imageMatch ? { image: imageMatch[1].trim().replace(/^['"]|['"]$/g, "") } : {},
        });
      }
    }

    return { entities, warnings };
  }
}

/**
 * Parser for Dockerfile content.
 */
export class DockerfileParser {
  parse(name: string, content: string): DockerfileIR {
    const instructions: Array<{ instruction: string; value: string }> = [];
    let from: string | undefined;

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const match = trimmed.match(/^([A-Z]+)\s+([\s\S]+)$/);
      if (!match) continue;

      const [, instruction, value] = match;
      if (instruction === "FROM") {
        from = value.trim();
      } else {
        instructions.push({ instruction, value: value.trim() });
      }
    }

    return { kind: "dockerfile", name, from, instructions };
  }
}
