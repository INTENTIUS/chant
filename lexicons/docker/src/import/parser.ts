/**
 * Docker Compose + Dockerfile parser — converts existing YAML/Dockerfiles
 * to an intermediate representation (IR) for TypeScript code generation.
 */

import { parseYAML } from "@intentius/chant/yaml";

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

export interface ConfigIR {
  kind: "config";
  name: string;
  props: Record<string, unknown>;
}

export interface SecretIR {
  kind: "secret";
  name: string;
  props: Record<string, unknown>;
}

export interface DockerfileStage {
  from: string;
  as?: string;
  instructions: Array<{ instruction: string; value: string }>;
}

export interface DockerfileIR {
  kind: "dockerfile";
  name: string;
  stages: DockerfileStage[];
}

export type DockerIR = ServiceIR | VolumeIR | NetworkIR | ConfigIR | SecretIR | DockerfileIR;

export interface ParseResult {
  entities: DockerIR[];
  warnings: string[];
}

const SERVICE_PROPS = [
  "image", "ports", "environment", "volumes", "depends_on",
  "restart", "healthcheck", "labels", "command", "entrypoint",
  "networks", "build", "deploy", "secrets", "configs",
] as const;

const VOLUME_PROPS = ["driver", "driver_opts", "external", "labels"] as const;
const NETWORK_PROPS = ["driver", "external", "attachable", "labels"] as const;
const CONFIG_PROPS = ["file", "external"] as const;
const SECRET_PROPS = ["file", "external"] as const;

function extractProps(
  raw: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const props: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in obj) props[key] = obj[key];
  }
  return props;
}

/**
 * Parser for docker-compose.yml files.
 * Converts YAML to an IR consumable by the TypeScript generator.
 */
export class DockerParser {
  parse(content: string): ParseResult {
    if (!content.trim()) return { entities: [], warnings: [] };

    const entities: DockerIR[] = [];
    const warnings: string[] = [];
    const doc = parseYAML(content) as Record<string, unknown>;

    // services
    const services = doc["services"];
    if (services && typeof services === "object" && !Array.isArray(services)) {
      for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
        entities.push({
          kind: "service",
          name,
          props: extractProps(raw, SERVICE_PROPS),
        });
      }
    }

    // volumes
    const volumes = doc["volumes"];
    if (volumes && typeof volumes === "object" && !Array.isArray(volumes)) {
      for (const [name, raw] of Object.entries(volumes as Record<string, unknown>)) {
        entities.push({
          kind: "volume",
          name,
          props: extractProps(raw, VOLUME_PROPS),
        });
      }
    }

    // networks
    const networks = doc["networks"];
    if (networks && typeof networks === "object" && !Array.isArray(networks)) {
      for (const [name, raw] of Object.entries(networks as Record<string, unknown>)) {
        entities.push({
          kind: "network",
          name,
          props: extractProps(raw, NETWORK_PROPS),
        });
      }
    }

    // configs
    const configs = doc["configs"];
    if (configs && typeof configs === "object" && !Array.isArray(configs)) {
      for (const [name, raw] of Object.entries(configs as Record<string, unknown>)) {
        entities.push({
          kind: "config",
          name,
          props: extractProps(raw, CONFIG_PROPS),
        });
      }
    }

    // secrets
    const secrets = doc["secrets"];
    if (secrets && typeof secrets === "object" && !Array.isArray(secrets)) {
      for (const [name, raw] of Object.entries(secrets as Record<string, unknown>)) {
        entities.push({
          kind: "secret",
          name,
          props: extractProps(raw, SECRET_PROPS),
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
    const stages: DockerfileStage[] = [];
    let current: DockerfileStage | null = null;

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const match = trimmed.match(/^([A-Z]+)\s+([\s\S]+)$/);
      if (!match) continue;

      const [, instruction, value] = match;

      if (instruction === "FROM") {
        // Parse "FROM image AS stagename"
        const asMatch = value.match(/^(.+?)\s+[Aa][Ss]\s+(\S+)$/);
        if (asMatch) {
          current = { from: asMatch[1].trim(), as: asMatch[2].trim(), instructions: [] };
        } else {
          current = { from: value.trim(), instructions: [] };
        }
        stages.push(current);
      } else if (current) {
        current.instructions.push({ instruction, value: value.trim() });
      }
    }

    return { kind: "dockerfile", name, stages };
  }
}
