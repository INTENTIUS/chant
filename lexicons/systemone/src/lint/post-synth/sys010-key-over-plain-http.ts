/**
 * SYS010: a backend sends its key over plain HTTP.
 *
 * A backend in `systemone.backends`, or in a `decide` step's own `backends`,
 * may have a key and an `http://` URL. The bearer key then crosses the
 * network in clear text. A loopback address
 * (127.0.0.1, ::1, localhost) is exempt, since that is where a local server
 * such as `von serve` or the stub runs, and where a broker that is itself the
 * endpoint listens.
 *
 * Read off the built entities: the backend entities `buildRoots()` makes from
 * the config, and the Op entities, which covers a step written with the
 * `decide` builder and one written with `activity("decide", ...)`.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { OpConfig, PhaseDefinition, ActivityStep } from "@intentius/chant/op";
import { isOpEntity } from "@intentius/chant/op/resource";
import { BACKEND_TYPE, type BackendEntity } from "../../backend-entities";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function* decideSteps(phases: PhaseDefinition[] | undefined): Generator<ActivityStep> {
  for (const phase of phases ?? []) {
    for (const step of phase.steps ?? []) {
      if (step.kind === "activity" && step.fn === "decide") yield step;
      else if (step.kind === "effect") {
        for (const nested of step.steps ?? []) if (nested.kind === "activity" && nested.fn === "decide") yield nested;
      }
    }
  }
}

/** The host of an http:// URL that is not loopback, or undefined. */
export function plainRemoteHost(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:") return undefined;
  return LOOPBACK.has(parsed.hostname) ? undefined : parsed.hostname;
}

export const sys010: PostSynthCheck = {
  id: "SYS010",
  description: "A systemone backend sends its key over plain HTTP to a host that is not loopback",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [entityKey, entity] of ctx.entities) {
      if (entity.entityType === BACKEND_TYPE) {
        const { name, url, key } = (entity as BackendEntity).props;
        const host = key !== undefined ? plainRemoteHost(url) : undefined;
        if (host) {
          diagnostics.push({
            checkId: "SYS010",
            severity: "error",
            message: `backend ${name} sends its key over http:// to ${host}; use https://, or a loopback broker`,
            entity: entityKey,
            lexicon: "systemone",
          });
        }
        continue;
      }
      if (!isOpEntity(entity)) continue;
      const props = ((entity as { props?: Record<string, unknown> }).props ?? {}) as unknown as OpConfig;
      for (const step of [...decideSteps(props.phases), ...decideSteps(props.onFailure)]) {
        const backends = (step.args as { backends?: unknown } | undefined)?.backends;
        if (backends === null || typeof backends !== "object") continue;
        for (const [name, b] of Object.entries(backends as Record<string, { url?: unknown; key?: unknown }>)) {
          if (b?.key === undefined) continue;
          const host = plainRemoteHost(b.url);
          if (!host) continue;
          diagnostics.push({
            checkId: "SYS010",
            severity: "error",
            message: `Op "${props.name}", decide ${JSON.stringify((step.args as { point?: unknown }).point)}: backend ${name} sends its key over http:// to ${host}; use https://, or a loopback broker`,
            entity: entityKey,
            lexicon: "systemone",
          });
        }
      }
    }
    return diagnostics;
  },
};
