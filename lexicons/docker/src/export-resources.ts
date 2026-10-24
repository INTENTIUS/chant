/**
 * Live export for the docker lexicon (#4388): implements
 * `LexiconPlugin.exportResources()` so `chant import --from <env>` regenerates
 * a compose project's services, and the configs they read, as chant
 * TypeScript.
 *
 * Which project: `COMPOSE_PROJECT_NAME` when set, else the environment name.
 * The containers are found by compose's `com.docker.compose.project` label.
 * All Engine I/O lives here; mapping is pure in `./import/live-export`.
 */

import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import { defaultDockerEngine, singleFileText, type DockerEngine } from "./import/engine";
import {
  buildExportFromProject,
  configCandidates,
  isChantOwned,
  PROJECT_LABEL,
  serviceContainers,
  type ContainerInspect,
  type ImageInspect,
  type LiveService,
} from "./import/live-export";

function json<T>(body: Buffer): T | undefined {
  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The compose project an environment exports. */
export function projectFor(environment: string): string {
  return process.env.COMPOSE_PROJECT_NAME || environment;
}

export async function exportResources(
  options: {
    environment: string;
    selector?: ResourceSelector;
    owned?: boolean;
    verbatim?: boolean;
  },
  engine: DockerEngine = defaultDockerEngine(),
  signal?: AbortSignal,
): Promise<ExportedTemplate> {
  const project = projectFor(options.environment);
  const filters = encodeURIComponent(JSON.stringify({ label: [`${PROJECT_LABEL}=${project}`] }));
  const list = await engine(`/containers/json?all=1&filters=${filters}`, signal);
  if (list.status !== 200) {
    throw new Error(`docker live export: listing the containers of compose project ${project} failed (${list.status}): ${list.body.toString("utf8").trim()}`);
  }
  const containers = serviceContainers(project, json<Array<{ Id?: string; Labels?: Record<string, string> }>>(list.body) ?? []);

  const services: LiveService[] = [];
  const images = new Map<string, ImageInspect | undefined>();
  for (const [name, id] of containers) {
    const res = await engine(`/containers/${encodeURIComponent(id)}/json`, signal);
    const container = res.status === 200 ? json<ContainerInspect>(res.body) : undefined;
    if (!container) continue;

    const ref = container.Config?.Image;
    if (ref && !images.has(ref)) {
      const img = await engine(`/images/${encodeURIComponent(ref)}/json`, signal);
      images.set(ref, img.status === 200 ? json<ImageInspect>(img.body) : undefined);
    }

    // Config files are read only for the services that are exported.
    const files: Record<string, string> = {};
    if (!options.owned || isChantOwned(container)) {
      for (const path of configCandidates(container)) {
        const res = await engine(`/containers/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(path)}`, signal);
        if (res.status !== 200) continue;
        const text = singleFileText(res.body);
        if (text !== undefined) files[path] = text;
      }
    }

    services.push({ name, container, image: ref ? images.get(ref) : undefined, files });
  }

  if (options.owned) {
    console.warn(
      "[docker] the docker serializer stamps no ownership marker; under --owned only services labelled app.kubernetes.io/managed-by=chant (defaultLabels) are exported",
    );
  }

  return buildExportFromProject(project, services, options);
}
