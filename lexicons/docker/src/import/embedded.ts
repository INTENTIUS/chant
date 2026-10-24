/**
 * Where a Compose file embeds another lexicon's content, for `chant import`
 * (#3373, #4388).
 *
 * A top-level config with `content` is a file Compose writes into each
 * container that mounts it. The parser offers that text to core's
 * embedded-content resolver, as k8s offers a ConfigMap value (#2962) and fly
 * a machine file. `DockerOtelCollector` carries its collector config this way,
 * at the otel lexicon's `COLLECTOR_CONFIG_PATH`, so a file or live import of
 * the project gives the same otel source `chant import config.yaml` gives.
 *
 * Which lexicon imports the content is decided by core at run time; the hint
 * below only names the owner a warning suggests when none is installed.
 */

import type { EmbeddedContent, EmbeddedContentResolver } from "@intentius/chant/import/embedded";
import { embeddedDocument } from "@intentius/chant/import/embedded";
import { COLLECTOR_CONFIG_PATH } from "@intentius/chant-lexicon-otel";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const COLLECTOR = { lexicon: "otel", what: "an OpenTelemetry Collector config" } as const;

function hintFor(targets: string[], doc: unknown): EmbeddedContent["expectedOwner"] {
  if (targets.includes(COLLECTOR_CONFIG_PATH)) return COLLECTOR;
  if (isRecord(doc) && isRecord(doc.service) && isRecord(doc.service.pipelines)) return COLLECTOR;
  return undefined;
}

/** Each service's mounts of top-level configs: config name, then the services and targets that mount it. */
function mountsByConfig(services: Record<string, unknown> | undefined): Map<string, Array<{ service: string; target: string }>> {
  const out = new Map<string, Array<{ service: string; target: string }>>();
  for (const [service, raw] of Object.entries(services ?? {})) {
    if (!isRecord(raw) || !Array.isArray(raw.configs)) continue;
    for (const c of raw.configs) {
      const source = typeof c === "string" ? c : isRecord(c) && typeof c.source === "string" ? c.source : undefined;
      if (!source) continue;
      const target = isRecord(c) && typeof c.target === "string" ? c.target : `/${source}`;
      const list = out.get(source) ?? [];
      list.push({ service, target });
      out.set(source, list);
    }
  }
  return out;
}

/**
 * Offer each top-level config's `content` to `embedded`, replacing the value
 * an owner imports with its reference. `configs` maps config name to its IR
 * properties and is changed in place with fresh copies; `services` is the
 * compose document's services section, read for where each config is mounted.
 *
 * The owner's modules go in a directory named after the one service that
 * mounts the config, else after the config, so a file import and a live
 * import (which cannot recover the config's key) write them to the same place.
 */
export function delegateEmbedded(
  configs: Map<string, Record<string, unknown>>,
  services: Record<string, unknown> | undefined,
  embedded: EmbeddedContentResolver,
): void {
  const mounts = mountsByConfig(services);
  for (const [name, props] of configs) {
    const text = props.content;
    if (typeof text !== "string") continue;
    const doc = embeddedDocument(text);
    if (!isRecord(doc)) continue;
    const users = mounts.get(name) ?? [];
    const owners = new Set(users.map((u) => u.service));
    const ref = embedded.resolve({
      host: "docker",
      hostType: "config",
      location: `config ${name} content`,
      directory: owners.size === 1 ? [...owners][0]! : name,
      text,
      document: doc,
      expectedOwner: hintFor(users.map((u) => u.target), doc),
    });
    if (ref) configs.set(name, { ...props, content: ref });
  }
}
