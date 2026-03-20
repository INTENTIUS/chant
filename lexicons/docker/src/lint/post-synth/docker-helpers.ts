/**
 * Shared YAML traversal utilities for Docker post-synth checks.
 */

export { getPrimaryOutput } from "@intentius/chant/lint/post-synth";

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
