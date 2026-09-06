/**
 * Coverage analysis for the fountain lexicon.
 *
 * The shared `computeCoverage` measures CloudFormation-shaped dimensions
 * (lifecycle flags, return attributes, extension constraints) that an
 * OpenAPI lexicon has no analog for — it would report 0% on
 * everything and mean nothing. What fountain actually needs to know is
 * whether its generated surface still matches upstream, measured against the
 * pinned spec release (see spec/fetch.ts):
 *
 *   1. Property coverage — request-schema properties per modeled kind vs
 *      what the committed surface baseline exposes. A gap means upstream
 *      added a field and `just generate` has not been rerun.
 *   2. Kind coverage — which request-shaped schemas are modeled as
 *      declarables, and which are deliberately not (with the reason), so
 *      an unmodeled kind is a decision on record rather than an omission.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fetchSchemas } from "./spec/fetch";
import { parseFountainOpenAPI, fountainShortName, MODELED_REQUEST_SCHEMAS } from "./spec/parse";

/**
 * Request schemas with no typed resource, and why.
 *
 * Every `*Request` schema in the pinned spec is either modeled or listed here.
 * v0.16.0 describes the whole product, not just the workload layer, so most of
 * this list is one restatement of the same three reasons: it is a session and
 * not a thing, it is an account operation and not estate, or it is write-only
 * and so could never be diffed.
 */
export const EXCLUDED_KINDS: Record<string, string> = {
  // Runs, turns, and the envelope around them.
  ConversationCreateRequest: "conversations are runs, not declarables — started by the fountainRun op",
  PromptRequest: "turn-level input inside a conversation run",
  PermissionAnswerRequest: "a human's answer to one tool card mid-run — an event on a conversation, not estate",
  TeamMessageRequest: "one turn addressed to a teammate — the run, not the seat",
  ChatCompletionRequest: "the OpenAI-compatible inference shim; a request to a model, unrelated to estate",
  ApplyRequest:
    "the envelope fountainApply builds around a manifest, not a thing anyone declares — " +
    "its contents are the Environment/Vault/Agent resources, which are modeled",

  // Write-only values: created once, never readable, so never diffable.
  SecretRequest: "secrets are a write-only sub-resource — upserted by fountainApply",
  VaultSecretRequest: "secrets are a write-only sub-resource — upserted by fountainApply",
  ApiKeyRequest:
    "an API key's value is returned once and never again — declaring one means recreating it on " +
    "every apply, or reporting it permanently unobservable. Same reason as SecretRequest",
  InferenceCredentialRequest: "a provider key, write-only for the same reason as ApiKeyRequest",
  SecretBindingRequest: "binds a stored secret to a host for the egress broker; the value behind it is write-only",

  // Partial updates of a modeled kind — chant declares the whole thing.
  TeamRenameRequest: "a partial update of a modeled Teammate — chant declares the full shape and applies it",
  TeamScheduleUpdateRequest: "a partial update of a modeled Schedule",
  WebhookEndpointUpdateRequest: "a partial update of a modeled Webhook",
  TeamContactRequest: "sets a teammate's email and phone (flag team_comms) — a per-seat contact detail, not estate",
  AvatarRequest: "sets an agent's avatar image; presentation, not configuration",
  AvatarGenerateRequest: "asks fountain to draw an avatar — a one-shot action with no resource behind it",

  // The account, its people, and its money.
  RegisterRequest: "account signup",
  AuthTokenRequest: "mints a session token; the credential chant reads from FOUNTAIN_TOKEN",
  TokenRequest: "mints a session token; the credential chant reads from FOUNTAIN_TOKEN",
  OAuthTokenRequest: "an OAuth token exchange",
  DeviceTokenRequest: "the device-code half of an interactive login",
  EmailRequest: "sends a verification or reset mail",
  EmailChangeRequest: "changes the account email",
  PasswordChangeRequest: "changes the account password",
  PasswordResetRequest: "completes a password reset",
  AccountDeleteRequest: "deletes the account — the opposite of estate",
  CreditsCheckoutRequest: "starts a Stripe checkout for credits",
  SupportReportCreateRequest: "files a support report",
  ConnectionProviderRequest: "registers an OAuth app for third-party connections; the connections themselves are per-user grants",
  BuzzProvisionRequest: "provisions a Buzz identity for an agent — a separate product surface",
  BuzzAccessUpdateRequest: "changes who may use a Buzz identity",

  // Instance administration. An operator's console, not a tenant's estate.
  AdminCompRequest: "instance administration — comps a user's balance",
  AdminCreditsRequest: "instance administration — grants credits",
  AdminRoleRequest: "instance administration — changes a user's role",
  AdminSandboxLimitRequest: "instance administration — sets a user's sandbox ceiling",
  AdminSuspendRequest: "instance administration — suspends a user",
};

/**
 * Upstream endpoints that exist but are absent from the OpenAPI spec, and the
 * decision about each.
 *
 * `EXCLUDED_KINDS` cannot carry these. It is keyed on request-schema names and
 * checked against the spec, so an entry for a schema upstream never publishes
 * would match nothing, prove nothing, and quietly keep meaning nothing if the
 * endpoint were later documented under a different name.
 *
 * These are the routes the coverage check is structurally blind to: fountain's
 * spec is generated by OpenApiSpex from controller annotations, so an
 * unannotated controller is invisible to every consumer of the spec, chant
 * included. Recording them here is the only way an unmodeled kind stays a
 * decision on record rather than something nobody noticed.
 */
export const UNSPECIFIED_ENDPOINTS: Record<string, string> = {
  // v0.16.0 annotates the api-keys controller, so `/api/auth/api-keys` and its
  // `ApiKeyRequest` are now visible to the spec-driven accounting above. The
  // entry that used to sit here moved to EXCLUDED_KINDS, which is what this
  // list's own comment said should happen: shrink rather than shadow.
};

export interface KindCoverage {
  kind: string;
  specProps: number;
  modeledProps: number;
  /** In the upstream request schema, absent from the generated surface. */
  missing: string[];
  /** In the generated surface, absent from the upstream request schema. */
  stale: string[];
}

export interface FountainCoverageReport {
  kinds: KindCoverage[];
  /** Request schemas modeled as declarables. */
  modeledKinds: string[];
  /** Request schemas deliberately not modeled → reason. */
  excludedKinds: Record<string, string>;
  /** Request schemas neither modeled nor on the exclusion list. */
  unaccountedKinds: string[];
  /** Upstream endpoints the spec does not describe → the decision about each. */
  unspecifiedEndpoints: Record<string, string>;
  /** Modeled properties as a percentage of upstream request properties. */
  overallPct: number;
}

interface SurfaceSnapshot {
  entries: Record<string, { kind: string; props?: string[] }>;
}

/** Strip the `name:required` encoding the surface baseline uses. */
function surfaceProps(entry: { props?: string[] }): string[] {
  return (entry.props ?? []).map((p) => p.split(":")[0]);
}

export function computeFountainCoverage(
  specJSON: string | Buffer,
  surface: SurfaceSnapshot,
): FountainCoverageReport {
  const parsed = parseFountainOpenAPI(specJSON);

  const kinds: KindCoverage[] = [];
  const modeledKinds: string[] = [];

  for (const result of parsed) {
    if (result.isProperty) continue;
    const kind = fountainShortName(result.resource.typeName);
    modeledKinds.push(kind);

    const specNames = result.resource.properties.map((p) => p.name);
    const entry = surface.entries[kind];
    const modeledNames = entry ? surfaceProps(entry) : [];

    const modeled = new Set(modeledNames);
    const spec = new Set(specNames);

    kinds.push({
      kind,
      specProps: specNames.length,
      modeledProps: specNames.filter((n) => modeled.has(n)).length,
      missing: specNames.filter((n) => !modeled.has(n)),
      stale: modeledNames.filter((n) => !spec.has(n)),
    });
  }

  // Which upstream request schemas are neither modeled nor excluded?
  const schemas = Object.keys(
    (JSON.parse(typeof specJSON === "string" ? specJSON : specJSON.toString("utf-8")) as {
      components?: { schemas?: Record<string, unknown> };
    }).components?.schemas ?? {},
  );
  // The request schema per modeled kind comes from the curated manifest, not
  // from `${kind}Request`: a Teammate is created by TeamAddRequest and a
  // Schedule by TeamScheduleCreateRequest.
  const modeledRequests = new Set(MODELED_REQUEST_SCHEMAS);
  const unaccountedKinds = schemas.filter(
    (name) =>
      name.endsWith("Request") && !modeledRequests.has(name) && !(name in EXCLUDED_KINDS),
  );

  const totalSpec = kinds.reduce((n, k) => n + k.specProps, 0);
  const totalModeled = kinds.reduce((n, k) => n + k.modeledProps, 0);

  return {
    kinds,
    modeledKinds,
    excludedKinds: EXCLUDED_KINDS,
    unaccountedKinds,
    unspecifiedEndpoints: UNSPECIFIED_ENDPOINTS,
    overallPct: totalSpec === 0 ? 0 : Math.round((totalModeled / totalSpec) * 100),
  };
}

export function formatSummary(report: FountainCoverageReport): string {
  const parts = report.kinds.map((k) => `${k.kind} ${k.modeledProps}/${k.specProps}`);
  return `Coverage: ${report.overallPct}% of upstream request properties (${parts.join(", ")}).`;
}

export function formatVerbose(report: FountainCoverageReport): string {
  const lines = [formatSummary(report), ""];

  for (const k of report.kinds) {
    lines.push(`${k.kind}: ${k.modeledProps}/${k.specProps} properties`);
    if (k.missing.length > 0) {
      lines.push(`  missing (upstream has, lexicon does not): ${k.missing.join(", ")}`);
    }
    if (k.stale.length > 0) {
      lines.push(`  stale (lexicon has, upstream does not): ${k.stale.join(", ")}`);
    }
  }

  lines.push("", "Not modeled as declarables:");
  for (const [name, reason] of Object.entries(report.excludedKinds)) {
    lines.push(`  ${name} — ${reason}`);
  }

  const unspecified = Object.entries(report.unspecifiedEndpoints);
  if (unspecified.length > 0) {
    lines.push("", "Upstream endpoints absent from the spec (coverage cannot see these):");
    for (const [route, reason] of unspecified) {
      lines.push(`  ${route} — ${reason}`);
    }
  }

  if (report.unaccountedKinds.length > 0) {
    lines.push(
      "",
      `Unaccounted request schemas (model them or add to EXCLUDED_KINDS): ${report.unaccountedKinds.join(", ")}`,
    );
  }

  return lines.join("\n");
}

/** Run coverage analysis for the fountain lexicon. */
/**
 * The offline path behind `coverageReport()` (#1330): the same computation
 * `coverage.test.ts` runs, over the committed spec snapshot and surface
 * baseline. Never `fetchSchemas()` — check-lexicon runs on every PR and must
 * not do network I/O.
 */
export function coverageReportFromSnapshots(basePath?: string): FountainCoverageReport {
  const base = basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  const spec = readFileSync(join(base, "src", "spec", "fountain-openapi.snapshot.json"), "utf-8");
  const surface = JSON.parse(
    readFileSync(join(base, "surface.snapshot.json"), "utf-8"),
  ) as SurfaceSnapshot;

  return computeFountainCoverage(spec, surface);
}

export async function analyzeFountainCoverage(opts?: {
  basePath?: string;
  verbose?: boolean;
  minOverall?: number;
}): Promise<FountainCoverageReport> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  const specs = await fetchSchemas();
  const specJSON = specs.get("fountain-openapi.json");
  if (!specJSON) throw new Error("fountain coverage: no spec returned by fetchSchemas");

  const surface = JSON.parse(
    readFileSync(join(basePath, "surface.snapshot.json"), "utf-8"),
  ) as SurfaceSnapshot;

  const report = computeFountainCoverage(specJSON, surface);

  console.error(opts?.verbose ? formatVerbose(report) : formatSummary(report));

  if (typeof opts?.minOverall === "number" && report.overallPct < opts.minOverall) {
    throw new Error(
      `Coverage ${report.overallPct}% is below the ${opts.minOverall}% threshold`,
    );
  }

  return report;
}
