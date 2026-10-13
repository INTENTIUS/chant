/**
 * SYS010: a `decide` backend sends its key over plain HTTP (#2740, core's
 * since #2828).
 *
 * A backend in `decide.backends` in chant.config, or in a `decide` step's own
 * `backends`, may have a key and an `http://` URL. The bearer key then crosses
 * the network in clear text. A loopback address (127.0.0.1, ::1, localhost)
 * is exempt, since that is where a local server such as `von serve` or the
 * stub runs, and where a broker that is itself the endpoint listens.
 *
 * The steps are read off the Op entities, which covers a step written with
 * the `decide` builder and one written with `activity("decide", ...)`. The
 * configured backends are not entities: `chant build` and `chant lint` read
 * them from the project's config and hand them to {@link sys010Check}. The id
 * keeps the SYS prefix it had in the systemone lexicon.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "../../post-synth";
import type { OpConfig, PhaseDefinition, ActivityStep } from "../../../op/types";
import type { DecideBackend } from "../../../op/decide-config";
import { isOpEntity } from "./support";

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

const DESCRIPTION = "A decide backend sends its key over plain HTTP to a host that is not loopback";

/**
 * SYS010 over the Op entities and, when given, the backends configured in
 * `decide.backends`. A configured backend's diagnostic names it as the entity
 * `decide.backends.<name>`.
 */
export function sys010Check(configured?: Record<string, Pick<DecideBackend, "url" | "key">>): PostSynthCheck {
  return {
    id: "SYS010",
    description: DESCRIPTION,

    check(ctx: PostSynthContext): PostSynthDiagnostic[] {
      const diagnostics: PostSynthDiagnostic[] = [];
      for (const [name, b] of Object.entries(configured ?? {})) {
        const host = b?.key !== undefined ? plainRemoteHost(b.url) : undefined;
        if (!host) continue;
        diagnostics.push({
          checkId: "SYS010",
          severity: "error",
          message: `decide.backends.${name} sends its key over http:// to ${host}; use https://, or a loopback broker`,
          entity: `decide.backends.${name}`,
        });
      }
      for (const [entityKey, entity] of ctx.entities) {
        if (!isOpEntity(entity)) continue;
        const rec = entity as unknown as Record<string, unknown>;
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
              lexicon: typeof rec.lexicon === "string" ? rec.lexicon : undefined,
            });
          }
        }
      }
      return diagnostics;
    },
  };
}

/** SYS010 over the Op entities alone, with no configured backends. */
export const sys010: PostSynthCheck = sys010Check();
