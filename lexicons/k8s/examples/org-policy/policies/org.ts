// Organizational policy — project-authored post-synth checks.
//
// These are the same `PostSynthCheck` shape lexicons ship as domain rules, but
// authored by *your org* and registered via `lint.policies` in chant.config.ts.
// They run during `chant build` over the resolved resources, with the current
// `--env` in context, so a policy can branch on environment. A check returning
// `severity: "error"` fails the build — the gate.
import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";

interface Manifest {
  kind?: string;
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: { tls?: unknown[] };
}

/**
 * Every parsed Kubernetes manifest across all lexicon outputs, via
 * `ctx.docs` (chant #975) — the shared, parse-once view every check and
 * policy gets, in place of hand-splitting `ctx.outputs` YAML/JSON. `d.error`
 * marks a document `parseOutputDocs` could not make sense of; skip it
 * rather than pass `undefined` along as a "manifest".
 */
function manifests(ctx: PostSynthContext): Manifest[] {
  return (ctx.docs ?? [])
    .filter((d) => !d.error)
    .map((d) => d.value as Manifest);
}

const COST_CENTER = "acme.io/cost-center";

/** Every workload must be attributable to a cost center — in every environment. */
export const costCenterRequired: PostSynthCheck = {
  id: "ORG-COST-CENTER",
  description: "every Deployment must carry an acme.io/cost-center label",
  check(ctx): PostSynthDiagnostic[] {
    const diags: PostSynthDiagnostic[] = [];
    for (const m of manifests(ctx)) {
      if (m.kind !== "Deployment") continue;
      // Literal key rather than `[COST_CENTER]` — EVL003 requires computed
      // keys to be statically evaluable literals.
      if (!m.metadata?.labels?.["acme.io/cost-center"]) {
        diags.push({
          checkId: "ORG-COST-CENTER",
          severity: "error",
          message: `Deployment "${m.metadata?.name}" is missing the ${COST_CENTER} label`,
          entity: m.metadata?.name,
        });
      }
    }
    return diags;
  },
};

/** Production ingress must terminate TLS. Lower environments may skip it. */
export const tlsRequiredInProd: PostSynthCheck = {
  id: "ORG-PROD-TLS",
  description: "in prod, every Ingress must terminate TLS",
  check(ctx): PostSynthDiagnostic[] {
    if (ctx.env !== "prod") return []; // the environment-aware branch
    const diags: PostSynthDiagnostic[] = [];
    for (const m of manifests(ctx)) {
      if (m.kind !== "Ingress") continue;
      const tls = m.spec?.tls;
      if (!Array.isArray(tls) || tls.length === 0) {
        diags.push({
          checkId: "ORG-PROD-TLS",
          severity: "error",
          message: `Ingress "${m.metadata?.name}" must terminate TLS in prod`,
          entity: m.metadata?.name,
        });
      }
    }
    return diags;
  },
};
