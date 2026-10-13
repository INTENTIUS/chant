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
  /**
   * The stage's instructions after FROM, in source order. `instruction` is
   * the upper-case keyword; `value` is the rest of the instruction as
   * written, line continuations and heredoc bodies included.
   */
  instructions: Array<{ instruction: string; value: string }>;
}

export interface DockerfileIR {
  kind: "dockerfile";
  name: string;
  /** ARG values declared before the first FROM. */
  globalArgs?: string[];
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

/** One logical Dockerfile instruction: its upper-case keyword and the rest as written. */
export interface DockerfileInstruction {
  instruction: string;
  value: string;
}

/**
 * Split Dockerfile content into logical instructions, in order. Comment
 * and blank lines are dropped (also inside a continued instruction, as
 * Docker does). A line ending in a backslash continues onto the next line,
 * and a heredoc (`RUN <<EOF` ... `EOF`) runs to its terminator; both are
 * kept in the value exactly as written, so writing the value back gives
 * the same instruction.
 */
export function splitDockerfileInstructions(content: string): DockerfileInstruction[] {
  const out: DockerfileInstruction[] = [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const first = lines[i]!;
    i++;
    const trimmed = first.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parts = [first.trimStart()];
    let last = first;
    while (/\\\s*$/.test(last) && i < lines.length) {
      const next = lines[i]!;
      i++;
      // Docker skips comment and empty lines inside a continued instruction.
      if (!next.trim() || next.trim().startsWith("#")) continue;
      parts.push(next);
      last = next;
    }

    // Heredocs: <<EOF, <<-EOF, <<"EOF", <<'EOF' (possibly several).
    const joined = parts.join("\n");
    const terminators = [...joined.matchAll(/<<(-?)(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g)].map((m) => ({ dash: m[1] === "-", word: m[3]! }));
    for (const t of terminators) {
      while (i < lines.length) {
        const body = lines[i]!;
        i++;
        parts.push(body);
        if ((t.dash ? body.replace(/^\t+/, "") : body) === t.word) break;
      }
    }

    const text = parts.join("\n").trimEnd();
    const match = text.match(/^([A-Za-z]+)(?:\s+([\s\S]*))?$/);
    if (!match) continue;
    out.push({ instruction: match[1]!.toUpperCase(), value: (match[2] ?? "").trimStart() });
  }
  return out;
}

/**
 * Parser for Dockerfile content.
 */
export class DockerfileParser {
  parse(name: string, content: string): DockerfileIR {
    const stages: DockerfileStage[] = [];
    const globalArgs: string[] = [];
    let current: DockerfileStage | null = null;

    for (const { instruction, value } of splitDockerfileInstructions(content)) {
      if (instruction === "FROM") {
        // Parse "FROM [--platform=...] image AS stagename"
        const asMatch = value.match(/^(.+?)\s+[Aa][Ss]\s+(\S+)$/);
        if (asMatch) {
          current = { from: asMatch[1]!.trim(), as: asMatch[2]!.trim(), instructions: [] };
        } else {
          current = { from: value.trim(), instructions: [] };
        }
        stages.push(current);
      } else if (current) {
        current.instructions.push({ instruction, value });
      } else if (instruction === "ARG") {
        globalArgs.push(value);
      }
    }

    return { kind: "dockerfile", name, ...(globalArgs.length > 0 ? { globalArgs } : {}), stages };
  }
}

/** Whether content reads as a Dockerfile: its first instruction is FROM or ARG, or it starts with a parser directive. */
export function looksLikeDockerfile(content: string): boolean {
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (/^#\s*(syntax|escape|check)\s*=/i.test(t)) return true;
    if (t.startsWith("#")) continue;
    return /^(FROM|ARG)\s/i.test(t);
  }
  return false;
}
