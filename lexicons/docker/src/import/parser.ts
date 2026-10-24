/**
 * Docker Compose + Dockerfile parser — converts existing YAML/Dockerfiles
 * to an intermediate representation (IR) for TypeScript code generation.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYAML } from "@intentius/chant/yaml";
import type { ParseContext } from "@intentius/chant/import/parser";
import { delegateEmbedded } from "./embedded";

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

/** The compose sections import reads, with the kind each holds and its entry in the lexicon. */
const SECTIONS = [
  { section: "services", kind: "service", entry: "Service" },
  { section: "volumes", kind: "volume", entry: "Volume" },
  { section: "networks", kind: "network", entry: "Network" },
  { section: "configs", kind: "config", entry: "DockerConfig" },
  { section: "secrets", kind: "secret", entry: "DockerSecret" },
] as const;

type ComposeKind = (typeof SECTIONS)[number]["kind"];

let fieldsCache: Map<ComposeKind, Set<string>> | undefined;

/**
 * The fields the Compose spec defines for each kind, read from the generated
 * lexicon (`lexicon-docker.json`, or `dist/meta.json` in a package built
 * without it). The props types come from the same spec (#3934), so import
 * keeps exactly what the types accept (#3937).
 */
export function composeFields(): Map<ComposeKind, Set<string>> {
  if (fieldsCache) return fieldsCache;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", "generated", "lexicon-docker.json"), join(here, "..", "..", "dist", "meta.json")];
  const path = candidates.find((c) => existsSync(c));
  if (!path) {
    throw new Error(`docker import: the generated lexicon is missing (tried ${candidates.join(", ")}); run npm run generate in lexicons/docker`);
  }
  const lexicon = JSON.parse(readFileSync(path, "utf-8")) as Record<string, { properties?: Record<string, unknown> }>;
  const fields = new Map<ComposeKind, Set<string>>();
  for (const { kind, entry } of SECTIONS) {
    fields.set(kind, new Set(Object.keys(lexicon[entry]?.properties ?? {})));
  }
  fieldsCache = fields;
  return fields;
}

/**
 * Keep every field the Compose spec defines for the kind, and `x-`
 * extension fields. Anything else is dropped and named in `warnings`.
 */
function extractProps(
  raw: unknown,
  allowed: Set<string>,
  where: string,
  kind: string,
  warnings: string[],
): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (allowed.has(key) || key.startsWith("x-")) props[key] = value;
    else warnings.push(`${where}: "${key}" is not a Compose ${kind} field and was dropped`);
  }
  return props;
}

/**
 * Parser for docker-compose.yml files.
 * Converts YAML to an IR consumable by the TypeScript generator.
 */
export class DockerParser {
  /**
   * With `context.embedded` (`chant import`), a config's `content` another
   * lexicon owns (a collector config) is handed to it (see ./embedded.ts).
   * Without it, every config is kept as written.
   */
  parse(content: string, context?: ParseContext): ParseResult {
    if (!content.trim()) return { entities: [], warnings: [] };
    return this.parseDocument(parseYAML(content) as Record<string, unknown>, context);
  }

  /** The same as {@link parse}, over a compose document already read (live export builds one). */
  parseDocument(doc: Record<string, unknown> | undefined, context?: ParseContext): ParseResult {
    const entities: DockerIR[] = [];
    const warnings: string[] = [];
    const fields = composeFields();

    const known = new Set<string>(SECTIONS.map((s) => s.section));
    for (const key of Object.keys(doc ?? {})) {
      if (!known.has(key)) warnings.push(`"${key}" at the top level is not imported`);
    }

    for (const { section, kind } of SECTIONS) {
      const entries = doc?.[section];
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
      for (const [name, raw] of Object.entries(entries as Record<string, unknown>)) {
        entities.push({
          kind,
          name,
          props: extractProps(raw, fields.get(kind)!, `${section}.${name}`, kind, warnings),
        } as DockerIR);
      }
    }

    if (context?.embedded) {
      const configs = new Map(entities.filter((e): e is ConfigIR => e.kind === "config").map((e) => [e.name, e.props]));
      const services = doc?.services;
      delegateEmbedded(configs, services && typeof services === "object" && !Array.isArray(services) ? (services as Record<string, unknown>) : undefined, context.embedded);
      for (const e of entities) if (e.kind === "config") e.props = configs.get(e.name)!;
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
