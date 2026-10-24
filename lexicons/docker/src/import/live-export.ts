/**
 * Pure export helpers for the docker lexicon (#4388): turn what the Engine API
 * returns for a compose project's containers back into the compose document a
 * user would have written, and map it to import IR through `DockerParser`. All
 * Engine I/O stays in the caller (`../export-resources`).
 *
 * A compose project is the set of containers labelled
 * `com.docker.compose.project=<name>`; each service is the container labelled
 * `com.docker.compose.service`, the lowest `container-number` when scaled.
 * One-off containers (`compose run`) are skipped.
 *
 * Configs. Outside swarm, a top-level config is not an Engine object. A
 * `content` config is copied into the container when it is created, and a
 * `file` config is bind-mounted; neither is named anywhere the Engine keeps.
 * What the container does keep is its command, so the files a service is
 * told to read (`--config=/etc/otelcol-contrib/config.yaml`) are the
 * candidates, and the caller reads each through
 * `GET /containers/{id}/archive?path=…`, which works for both forms and for a
 * remote Engine whose host paths are out of reach. A candidate that reads back
 * as one text file becomes a `content` config mounted at that path, named
 * `<service>-<file name>` (the original key is not recoverable). A candidate
 * inside a volume or a directory bind mount belongs to that mount and is not
 * read.
 *
 * The strip. By default fields the image supplies (its command, entrypoint,
 * environment, labels, working dir and user) are dropped, so a service reaches
 * the shape it was declared in; `verbatim` keeps them. Compose's own
 * `com.docker.compose.*` labels are always dropped: compose writes them, and a
 * declaration that set them would fight it.
 *
 * Ownership. The docker serializer stamps no marker, so under `owned` only
 * services carrying the label marker (`app.kubernetes.io/managed-by: chant`,
 * set with `defaultLabels`) are exported, and the caller logs that once.
 */

import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import type { ParseContext, TemplateIR } from "@intentius/chant/import/parser";
import { hasOwnershipMarker, LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";
import { DockerParser } from "./parser";
import { dockerResultToTemplate } from "./adapter";

export const PROJECT_LABEL = "com.docker.compose.project";
export const SERVICE_LABEL = "com.docker.compose.service";
const NUMBER_LABEL = "com.docker.compose.container-number";
const ONEOFF_LABEL = "com.docker.compose.oneoff";
const DEPENDS_LABEL = "com.docker.compose.depends_on";

type Json = Record<string, unknown>;

/** A container's or an image's healthcheck, durations in nanoseconds. */
export interface HealthcheckInspect {
  Test?: string[];
  Interval?: number;
  Timeout?: number;
  Retries?: number;
  StartPeriod?: number;
}

/** What `GET /containers/{id}/json` returns, as far as export reads it. */
export interface ContainerInspect {
  Id?: string;
  Name?: string;
  Config?: {
    Image?: string;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    Env?: string[] | null;
    Labels?: Record<string, string> | null;
    WorkingDir?: string;
    User?: string;
    Healthcheck?: HealthcheckInspect | null;
  };
  HostConfig?: {
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | null;
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number } | null;
  };
  Mounts?: Array<{ Type?: string; Name?: string; Source?: string; Destination?: string; RW?: boolean }>;
  NetworkSettings?: { Networks?: Record<string, unknown> | null };
}

/** What `GET /images/{name}/json` returns, as far as export reads it. */
export interface ImageInspect {
  Config?: {
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    Env?: string[] | null;
    Labels?: Record<string, string> | null;
    WorkingDir?: string;
    User?: string;
    Healthcheck?: HealthcheckInspect | null;
  };
}

/** One service as read from the Engine: its container, its image, and the config files read out of it. */
export interface LiveService {
  name: string;
  container: ContainerInspect;
  image?: ImageInspect;
  /** Config target path → the text read from the container. */
  files: Record<string, string>;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The containers to export, one per service: compose-labelled for `project`,
 * not one-off, and the lowest container number when a service is scaled.
 * `summaries` is what `GET /containers/json` returns.
 */
export function serviceContainers(project: string, summaries: Array<{ Id?: string; Labels?: Record<string, string> | null }>): Map<string, string> {
  const best = new Map<string, { id: string; n: number }>();
  for (const s of summaries) {
    const labels = s.Labels ?? {};
    if (labels[PROJECT_LABEL] !== project || !s.Id) continue;
    if ((labels[ONEOFF_LABEL] ?? "").toLowerCase() === "true") continue;
    const service = labels[SERVICE_LABEL];
    if (!service) continue;
    const n = Number(labels[NUMBER_LABEL] ?? "1") || 1;
    const prev = best.get(service);
    if (!prev || n < prev.n) best.set(service, { id: s.Id, n });
  }
  return new Map([...best].sort(([a], [b]) => a.localeCompare(b)).map(([service, { id }]) => [service, id]));
}

function under(path: string, dir: string): boolean {
  const d = dir.endsWith("/") ? dir : `${dir}/`;
  return path.startsWith(d);
}

/**
 * The paths a container's command names that may be config files: an
 * absolute path with a file extension, alone or as a `--flag=` value (an
 * otel `file:` URI included). A path inside a volume, or inside a directory
 * bind mount, belongs to that mount and is left out.
 */
export function configCandidates(container: ContainerInspect): string[] {
  const args = [...(container.Config?.Entrypoint ?? []), ...(container.Config?.Cmd ?? [])];
  const mounts = container.Mounts ?? [];
  const out: string[] = [];
  for (const arg of args) {
    let value = arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
    if (value.startsWith("file:")) value = value.slice("file:".length);
    if (!/^\/[^\s,;:]+$/.test(value)) continue;
    const base = value.split("/").pop()!;
    if (!/\.[A-Za-z0-9]+$/.test(base)) continue;
    if (mounts.some((m) => m.Destination && under(value, m.Destination))) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function stripProjectPrefix(project: string, name: string): string | undefined {
  return name.startsWith(`${project}_`) ? name.slice(project.length + 1) : undefined;
}

function envMap(env: string[]): Json {
  const out: Json = {};
  for (const e of env) {
    const i = e.indexOf("=");
    if (i === -1) out[e] = null;
    else out[e.slice(0, i)] = e.slice(i + 1);
  }
  return out;
}

function duration(ns: number | undefined): string | undefined {
  if (!ns) return undefined;
  const ms = ns / 1e6;
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

function portList(bindings: NonNullable<ContainerInspect["HostConfig"]>["PortBindings"]): string[] {
  const out: string[] = [];
  for (const [key, binds] of Object.entries(bindings ?? {})) {
    const [port, proto] = key.split("/");
    const suffix = proto && proto !== "tcp" ? `/${proto}` : "";
    if (!binds || binds.length === 0) {
      out.push(`${port}${suffix}`);
      continue;
    }
    for (const b of binds) {
      const ip = b.HostIp && b.HostIp !== "0.0.0.0" && b.HostIp !== "::" ? `${b.HostIp}:` : "";
      out.push(b.HostPort ? `${ip}${b.HostPort}:${port}${suffix}` : `${port}${suffix}`);
    }
  }
  // The Engine may list `::` and `0.0.0.0` bindings of one port separately.
  return [...new Set(out)];
}

function dependsOn(label: string | undefined): unknown {
  if (!label) return undefined;
  const entries = label
    .split(",")
    .map((e) => e.split(":"))
    .filter(([name]) => !!name);
  if (entries.length === 0) return undefined;
  if (entries.every(([, condition, restart]) => (condition ?? "service_started") === "service_started" && restart !== "true")) {
    return entries.map(([name]) => name);
  }
  return Object.fromEntries(
    entries.map(([name, condition, restart]) => [name, { condition: condition || "service_started", ...(restart === "true" ? { restart: true } : {}) }]),
  );
}

/** The compose service a container was created from, and the config files it mounts. */
function serviceFromContainer(
  project: string,
  live: LiveService,
  verbatim: boolean,
): { service: Json; configs: Array<{ name: string; target: string; content: string }>; volumes: string[]; networks: string[] } {
  const c = live.container.Config ?? {};
  const img = live.image?.Config ?? {};
  const keep = (live: unknown, image: unknown) => verbatim || !same(live, image);
  const service: Json = {};

  if (c.Image) service.image = c.Image;
  if (c.Entrypoint && c.Entrypoint.length > 0 && keep(c.Entrypoint, img.Entrypoint)) service.entrypoint = c.Entrypoint;
  if (c.Cmd && c.Cmd.length > 0 && keep(c.Cmd, img.Cmd)) service.command = c.Cmd;

  const imageEnv = new Set(img.Env ?? []);
  const env = (c.Env ?? []).filter((e) => verbatim || !imageEnv.has(e));
  if (env.length > 0) service.environment = envMap(env);

  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.Labels ?? {})) {
    if (k.startsWith("com.docker.compose.")) continue;
    if (!verbatim && img.Labels?.[k] === v) continue;
    labels[k] = v;
  }
  if (Object.keys(labels).length > 0) service.labels = labels;

  if (c.WorkingDir && keep(c.WorkingDir, img.WorkingDir ?? "")) service.working_dir = c.WorkingDir;
  if (c.User && keep(c.User, img.User ?? "")) service.user = c.User;

  if (c.Healthcheck?.Test && c.Healthcheck.Test.length > 0 && keep(c.Healthcheck, img.Healthcheck)) {
    const h = c.Healthcheck;
    service.healthcheck = {
      test: h.Test,
      ...(duration(h.Interval) ? { interval: duration(h.Interval) } : {}),
      ...(duration(h.Timeout) ? { timeout: duration(h.Timeout) } : {}),
      ...(h.Retries ? { retries: h.Retries } : {}),
      ...(duration(h.StartPeriod) ? { start_period: duration(h.StartPeriod) } : {}),
    };
  }

  const ports = portList(live.container.HostConfig?.PortBindings);
  if (ports.length > 0) service.ports = ports;

  const restart = live.container.HostConfig?.RestartPolicy;
  if (restart?.Name && restart.Name !== "no") {
    service.restart = restart.Name === "on-failure" && restart.MaximumRetryCount ? `on-failure:${restart.MaximumRetryCount}` : restart.Name;
  }

  const deps = dependsOn(c.Labels?.[DEPENDS_LABEL]);
  if (deps !== undefined) service.depends_on = deps;

  // Mounts: a config read at a mount's destination is that config, not a volume.
  const volumes: string[] = [];
  const mountList: string[] = [];
  for (const m of live.container.Mounts ?? []) {
    if (!m.Destination || live.files[m.Destination] !== undefined) continue;
    const ro = m.RW === false ? ":ro" : "";
    if (m.Type === "volume" && m.Name) {
      const key = stripProjectPrefix(project, m.Name);
      if (key) {
        volumes.push(key);
        mountList.push(`${key}:${m.Destination}${ro}`);
      } else if (/^[0-9a-f]{64}$/.test(m.Name)) {
        mountList.push(m.Destination);
      } else {
        volumes.push(m.Name);
        mountList.push(`${m.Name}:${m.Destination}${ro}`);
      }
    } else if (m.Type === "bind" && m.Source) {
      mountList.push(`${m.Source}:${m.Destination}${ro}`);
    }
  }
  if (mountList.length > 0) service.volumes = mountList;

  const networks: string[] = [];
  for (const net of Object.keys(live.container.NetworkSettings?.Networks ?? {})) {
    networks.push(stripProjectPrefix(project, net) ?? net);
  }
  const declaredNets = networks.filter((n) => n !== "default");
  if (declaredNets.length > 0) service.networks = networks;

  const configs = Object.entries(live.files).map(([target, content]) => {
    const base = target.split("/").pop()!.replace(/\.[^.]*$/, "");
    return { name: `${live.name}-${base}`, target, content };
  });
  if (configs.length > 0) service.configs = configs.map(({ name, target }) => ({ source: name, target }));

  return { service, configs, volumes, networks: declaredNets };
}

/**
 * The compose document a project's services were created from. External
 * volumes and networks (not prefixed with the project name) are declared
 * `external`.
 */
export function composeFromLive(project: string, services: LiveService[], opts: { verbatim?: boolean } = {}): Json {
  const doc: { services: Json; configs: Json; volumes: Json; networks: Json } = { services: {}, configs: {}, volumes: {}, networks: {} };
  for (const live of services) {
    const { service, configs, volumes, networks } = serviceFromContainer(project, live, opts.verbatim ?? false);
    doc.services[live.name] = service;
    for (const cfg of configs) doc.configs[cfg.name] = { content: cfg.content };
    for (const v of volumes) {
      const owned = (live.container.Mounts ?? []).some((m) => m.Name === `${project}_${v}`);
      doc.volumes[v] = owned ? {} : { external: true };
    }
    for (const n of networks) {
      const owned = Object.keys(live.container.NetworkSettings?.Networks ?? {}).includes(`${project}_${n}`);
      doc.networks[n] = owned ? {} : { external: true };
    }
  }
  const out: Json = { services: doc.services };
  for (const section of ["volumes", "networks", "configs"] as const) {
    if (Object.keys(doc[section]).length > 0) out[section] = doc[section];
  }
  return out;
}

/** Whether a container carries chant's label marker. */
export function isChantOwned(container: ContainerInspect): boolean {
  return hasOwnershipMarker(container.Config?.Labels ?? undefined, LABEL_OWNERSHIP_KEYS);
}

/**
 * Build export IR from one compose project's services, through
 * {@link DockerParser} as the single compose → IR mapping. `owned` keeps only
 * services carrying chant's marker; `selector` narrows by IR type (`service`,
 * `config`, …) and compose key. `reparse(context)` parses the same document
 * again with a `ParseContext`, so `chant import --from` hands a collector
 * config to the otel importer, as a file import does (#3373).
 */
export function buildExportFromProject(
  project: string,
  services: LiveService[],
  opts: { verbatim?: boolean; selector?: ResourceSelector; owned?: boolean } = {},
): ExportedTemplate {
  const kept = opts.owned ? services.filter((s) => isChantOwned(s.container)) : services;
  if (kept.length === 0) return { resources: [], parameters: [] };
  const doc = composeFromLive(project, kept, { verbatim: opts.verbatim });
  const parse = (context?: ParseContext): TemplateIR =>
    select(dockerResultToTemplate(new DockerParser().parseDocument(doc, context)), opts.selector);
  return { ...parse(), reparse: (context) => parse(context) };
}

function select(ir: TemplateIR, selector: ResourceSelector | undefined): TemplateIR {
  if (!selector || (selector.type === undefined && selector.name === undefined)) return ir;
  return {
    ...ir,
    resources: ir.resources.filter(
      (r) => (selector.type === undefined || r.type === selector.type) && (selector.name === undefined || r.logicalId === selector.name),
    ),
  };
}
