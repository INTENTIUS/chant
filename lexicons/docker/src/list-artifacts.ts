/**
 * Live introspection of a Docker host via three independent CLI queries.
 *
 * The Docker lexicon's chant entities describe Compose / Dockerfile
 * authoring primitives. The runtime concept (running containers, local
 * images, networks) is created by `docker compose up` / `docker run` /
 * `docker network create` outside chant's entity model.
 *
 *   docker ps         --format '{{json .}}'  → running containers
 *   docker image ls   --format '{{json .}}'  → local images
 *   docker network ls --format '{{json .}}'  → networks
 *
 * Output is one JSON object per line (NDJSON), not a JSON array. Daemon
 * unreachable on any query → that query returns nothing; other queries
 * still proceed.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ArtifactMetadata } from "@intentius/chant/lexicon";

const execAsync = promisify(exec);

interface DockerContainer {
  Names?: string;
  ID?: string;
  Image?: string;
  Command?: string;
  State?: string;        // "running" | "exited" | "created" | ...
  Status?: string;       // "Up 5 minutes" | "Exited (0) 1 hour ago" | ...
  Ports?: string;
  Mounts?: string;
}

interface DockerImage {
  ID?: string;
  Repository?: string;
  Tag?: string;
  CreatedAt?: string;
  Size?: string;
}

interface DockerNetwork {
  ID?: string;
  Name?: string;
  Driver?: string;
  Scope?: string;
  CreatedAt?: string;
}

function parseNdjson<T>(stdout: string): T[] {
  const out: T[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

async function listContainers(): Promise<Record<string, ArtifactMetadata>> {
  const result: Record<string, ArtifactMetadata> = {};
  try {
    const { stdout } = await execAsync("docker ps --format '{{json .}}'");
    const containers = parseNdjson<DockerContainer>(stdout);
    for (const c of containers) {
      const name = c.Names;
      if (!name) continue;
      result[`container/${name}`] = {
        type: "Docker::Container",
        physicalId: c.ID,
        status: c.State ?? c.Status ?? "PRESENT",
        attributes: pruneUndefined({
          image: c.Image,
          command: c.Command,
          ports: c.Ports,
          mounts: c.Mounts,
          fullStatus: c.Status,
        }),
      };
    }
  } catch {
    // Docker daemon unreachable — return empty, don't fail the lexicon
  }
  return result;
}

async function listImages(): Promise<Record<string, ArtifactMetadata>> {
  const result: Record<string, ArtifactMetadata> = {};
  try {
    const { stdout } = await execAsync("docker image ls --format '{{json .}}'");
    const images = parseNdjson<DockerImage>(stdout);
    for (const img of images) {
      if (!img.Repository || img.Repository === "<none>") continue;
      const tag = img.Tag && img.Tag !== "<none>" ? img.Tag : "latest";
      const key = `image/${img.Repository}:${tag}`;
      result[key] = {
        type: "Docker::Image",
        physicalId: img.ID,
        status: "PRESENT",
        lastUpdated: img.CreatedAt,
        attributes: pruneUndefined({
          repository: img.Repository,
          tag,
          size: img.Size,
        }),
      };
    }
  } catch {
    // Docker daemon unreachable
  }
  return result;
}

async function listNetworks(): Promise<Record<string, ArtifactMetadata>> {
  const result: Record<string, ArtifactMetadata> = {};
  try {
    const { stdout } = await execAsync("docker network ls --format '{{json .}}'");
    const networks = parseNdjson<DockerNetwork>(stdout);
    for (const net of networks) {
      const name = net.Name;
      if (!name) continue;
      result[`network/${name}`] = {
        type: "Docker::Network",
        physicalId: net.ID,
        status: "PRESENT",
        lastUpdated: net.CreatedAt,
        attributes: pruneUndefined({
          driver: net.Driver,
          scope: net.Scope,
        }),
      };
    }
  } catch {
    // Docker daemon unreachable
  }
  return result;
}

export async function listArtifacts(_options: {
  environment: string;
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
}): Promise<Record<string, ArtifactMetadata>> {
  // Three independent queries — failure of one doesn't block the others.
  const [containers, images, networks] = await Promise.all([
    listContainers(),
    listImages(),
    listNetworks(),
  ]);

  return { ...containers, ...images, ...networks };
}
