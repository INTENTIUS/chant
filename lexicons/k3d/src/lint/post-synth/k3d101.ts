/**
 * K3D101: malformed nodeFilters.
 *
 * `nodeFilters` are k3d's own selector syntax and the schema types them as
 * bare strings, so a typo validates, applies to nothing, and reports
 * nothing — the port mapping or volume silently lands nowhere. This is the
 * silent-at-create failure worth an error.
 *
 * Valid forms (k3d v5): `all`, `loadbalancer`, or `server`/`agent` with an
 * optional `:<index>` / `:*`, and for port mappings an optional trailing
 * `:direct` / `:proxy`.
 */

import { load, loadAll } from "js-yaml";
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";

const VALID_FILTER = /^(all|loadbalancer|server|agent)(:(\d+|\*))?(:(direct|proxy))?$/;

export function k3dDocuments(ctx: PostSynthContext): Array<{ source: string; doc: unknown }> {
  const docs: Array<{ source: string; doc: unknown }> = [];
  for (const [outputName, output] of ctx.outputs) {
    const texts: Array<[string, string]> =
      typeof output === "string"
        ? [[outputName, output]]
        : [
            [outputName, (output as SerializerResult).primary],
            ...Object.entries((output as SerializerResult).files ?? {}),
          ];
    for (const [source, text] of texts) {
      if (!text || !text.includes("k3d.io/")) continue;
      try {
        for (const doc of loadAll(text)) docs.push({ source, doc });
      } catch {
        try {
          docs.push({ source, doc: load(text) });
        } catch {
          // not YAML — someone else's output
        }
      }
    }
  }
  return docs;
}

function collectFilters(value: unknown, path: string, out: Array<{ path: string; filter: string }>): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectFilters(v, `${path}[${i}]`, out));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === "nodeFilters" && Array.isArray(v)) {
      v.forEach((f, i) => {
        if (typeof f === "string") out.push({ path: `${path}.nodeFilters[${i}]`, filter: f });
      });
      continue;
    }
    collectFilters(v, path ? `${path}.${key}` : key, out);
  }
}

export const k3d101: PostSynthCheck = {
  id: "K3D101",
  description: "A nodeFilter that matches no node applies to nothing, silently",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const { source, doc } of k3dDocuments(ctx)) {
      const filters: Array<{ path: string; filter: string }> = [];
      collectFilters(doc, "", filters);
      for (const { path, filter } of filters) {
        if (VALID_FILTER.test(filter)) continue;
        diagnostics.push({
          checkId: "K3D101",
          severity: "error",
          message:
            `${source}: nodeFilter "${filter}" at ${path} is not a k3d selector — valid forms are ` +
            `"all", "loadbalancer", "server"/"agent" with optional ":<index>" or ":*", plus ` +
            `":direct"/":proxy" on port mappings. k3d applies an unmatched filter to nothing and says nothing.`,
          lexicon: "k3d",
        });
      }
    }
    return diagnostics;
  },
};
