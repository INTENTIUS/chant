/**
 * Shared YAML traversal utilities for Docker post-synth checks.
 */

export { getPrimaryOutput } from "@intentius/chant/lint/post-synth";
import { splitDockerfileInstructions } from "../../import/parser";

export interface ParsedService {
  name: string;
  image?: string;
  ports?: string[];
  volumes?: string[];
  build?: { dockerfile?: string; context?: string };
  depends_on?: string[];
}

/**
 * Extract services section from serialized docker-compose.yml.
 */
export function extractServices(yaml: string): Map<string, ParsedService> {
  const services = new Map<string, ParsedService>();

  const servicesIdx = yaml.search(/^services:\s*$/m);
  if (servicesIdx === -1) return services;

  const afterServices = yaml.slice(servicesIdx + yaml.slice(servicesIdx).indexOf("\n") + 1);
  // Stop at next top-level key
  const endMatch = afterServices.search(/^[a-z]/m);
  const servicesContent = endMatch === -1 ? afterServices : afterServices.slice(0, endMatch);

  // Split by service entries (2-space indent + name:)
  const sections = servicesContent.split(/\n(?=  [a-z][a-z0-9_-]*:)/);

  for (const section of sections) {
    const nameMatch = section.match(/^\s{2}([a-z][a-z0-9_-]*):/);
    if (!nameMatch) continue;

    const name = nameMatch[1];
    const svc: ParsedService = { name };

    const imageMatch = section.match(/^\s{4}image:\s+(.+)$/m);
    if (imageMatch) svc.image = imageMatch[1].trim().replace(/^['"]|['"]$/g, "");

    const portsMatch = section.match(/^\s{4}ports:\n((?:\s{6}- .+\n?)+)/m);
    if (portsMatch) {
      svc.ports = [];
      for (const line of portsMatch[1].split("\n")) {
        const item = line.match(/^\s{6}-\s+['"]?(.+?)['"]?$/);
        if (item) svc.ports.push(item[1].trim());
      }
    }

    const volsMatch = section.match(/^\s{4}volumes:\n((?:\s{6}- .+\n?)+)/m);
    if (volsMatch) {
      svc.volumes = [];
      for (const line of volsMatch[1].split("\n")) {
        const item = line.match(/^\s{6}-\s+['"]?(.+?)['"]?$/);
        if (item) svc.volumes.push(item[1].trim());
      }
    }

    services.set(name, svc);
  }

  return services;
}

/**
 * Extract named volumes from the top-level volumes: section.
 */
export function extractNamedVolumes(yaml: string): Set<string> {
  const volumes = new Set<string>();

  const volumesIdx = yaml.search(/^volumes:\s*$/m);
  if (volumesIdx === -1) return volumes;

  const afterVolumes = yaml.slice(volumesIdx + yaml.slice(volumesIdx).indexOf("\n") + 1);
  const endMatch = afterVolumes.search(/^[a-z]/m);
  const volumesContent = endMatch === -1 ? afterVolumes : afterVolumes.slice(0, endMatch);

  for (const line of volumesContent.split("\n")) {
    const match = line.match(/^\s{2}([a-z][a-z0-9_-]*):/);
    if (match) volumes.add(match[1]);
  }

  return volumes;
}

/**
 * Check if an image tag represents :latest or is untagged.
 */
export function isLatestOrUntagged(image: string): boolean {
  if (!image || image.startsWith("${")) return false;
  if (image.endsWith(":latest")) return true;
  const parts = image.split("/");
  const lastPart = parts[parts.length - 1];
  return !lastPart.includes(":") && !lastPart.includes("@");
}

/**
 * Get Dockerfile content from SerializerResult files map.
 */
export function extractDockerfiles(output: unknown): Map<string, string> {
  const files = new Map<string, string>();
  if (typeof output !== "object" || output === null) return files;
  if (!("files" in output)) return files;

  const outputFiles = (output as { files: Record<string, string> }).files;
  for (const [name, content] of Object.entries(outputFiles)) {
    if (name.startsWith("Dockerfile")) {
      files.set(name, content);
    }
  }
  return files;
}

// ── Dockerfile structure ──────────────────────────────────────────

export interface DockerfileInstr {
  /** Upper-case keyword, e.g. "RUN". */
  instruction: string;
  /** The rest of the instruction as written. */
  value: string;
}

export interface ParsedStage {
  /** 0-based position among the stages. */
  index: number;
  /** The FROM image (or earlier stage) without `--platform` and `AS`. */
  from: string;
  as?: string;
  instructions: DockerfileInstr[];
}

export interface ParsedDockerfile {
  /** ARG instructions before the first FROM. */
  globalArgs: DockerfileInstr[];
  stages: ParsedStage[];
}

/** A Dockerfile's global ARGs and stages, each stage's instructions in order. */
export function parseDockerfileStages(content: string): ParsedDockerfile {
  const out: ParsedDockerfile = { globalArgs: [], stages: [] };
  for (const instr of splitDockerfileInstructions(content)) {
    if (instr.instruction === "FROM") {
      const words = instr.value.split(/\s+/).filter((w) => !w.startsWith("--"));
      const asAt = words.findIndex((w) => w.toLowerCase() === "as");
      out.stages.push({
        index: out.stages.length,
        from: words[0] ?? "",
        ...(asAt > 0 && words[asAt + 1] ? { as: words[asAt + 1] } : {}),
        instructions: [],
      });
    } else if (out.stages.length > 0) {
      out.stages[out.stages.length - 1]!.instructions.push(instr);
    } else if (instr.instruction === "ARG") {
      out.globalArgs.push(instr);
    }
  }
  return out;
}

/** How a stage is named in a message: `stage "build"` or `stage 2`. */
export function stageLabel(stage: ParsedStage): string {
  return stage.as ? `stage "${stage.as}"` : `stage ${stage.index + 1}`;
}

/** The first line of an instruction, for a message. */
export function instrText(instr: DockerfileInstr): string {
  const first = instr.value.split("\n")[0]!.replace(/\s*\\$/, "");
  return `${instr.instruction} ${first}`;
}

/** Whether a USER value is root (by name or uid 0, with or without a group). */
export function isRootUser(value: string): boolean {
  const user = value.trim().split(":")[0]!;
  return user === "root" || user === "0";
}

/** Every generated Dockerfile in a build's outputs, parsed. */
export function eachDockerfile(outputs: Map<string, unknown>): Array<{ fileName: string; content: string; parsed: ParsedDockerfile }> {
  const out: Array<{ fileName: string; content: string; parsed: ParsedDockerfile }> = [];
  for (const [, output] of outputs) {
    for (const [fileName, content] of extractDockerfiles(output)) {
      out.push({ fileName, content, parsed: parseDockerfileStages(content) });
    }
  }
  return out;
}

/** A RUN value with its line continuations joined, for matching commands. */
export function commandText(instr: DockerfileInstr): string {
  return instr.value.replace(/\\[ \t]*\n/g, " ");
}
