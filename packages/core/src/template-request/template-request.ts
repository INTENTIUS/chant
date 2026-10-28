/**
 * The template request, template-request/v1 (#4651): "an app named orders
 * from template X at version Y with these inputs", as one JSON document.
 * terragucci, plywood and behold all turn one into a pull request, and this
 * module is where they agree on the document, its refusals and its branch.
 * ./request-body.ts writes the pull request body that carries it.
 *
 * {@link checkTemplateRequest} reads the release catalog for the version's
 * status and attestation, and the version's template.yml (./template-spec.ts)
 * for its inputs. It reads no engine field: the inputs' kinds are
 * engine-neutral.
 */

import schema from "./template-request.schema.json" with { type: "json" };
import { NEXT_RELEASE } from "../release-floors";
import { catalogVersion, type AttestationState, type CatalogComponent, type ReleaseCatalog } from "../lifecycle/release-catalog";
import { inputKindProblem, inputRequired, type TemplateSpec } from "./template-spec";
import { schemaProblems } from "./validate";

/** The first chant that writes and reads template-request/v1 and template.yml/v1 (#4651). */
export const TEMPLATE_REQUEST_FLOOR = NEXT_RELEASE;

/** The request document's `$schema`. */
export const TEMPLATE_REQUEST_SCHEMA_ID: string = schema.$id;

/** The request's contract version. */
export const TEMPLATE_REQUEST_CONTRACT = 1;

/** An app or add-on name: a lowercase letter, then up to 39 lowercase letters, digits and -. */
export const REQUEST_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** Where a request came from. */
export type TemplateRequestVia = "form" | "mcp" | "cli";

/** A template request. */
export interface TemplateRequest {
  $schema: string;
  contract: 1;
  kind: "app" | "addon";
  /** The template's address, such as `acme/bucket/aws`. */
  template: string;
  /** The version in the catalog, or a digest for a release that names none. */
  version: string;
  app: string;
  /** For kind `addon`: the add-on's name. */
  addon?: string;
  /** The values given, by input name. */
  inputs: Record<string, unknown>;
  requestedBy: string;
  via: TemplateRequestVia;
}

/** The fields a caller gives {@link makeTemplateRequest}; `$schema` and `contract` are filled in. */
export type TemplateRequestInput = Omit<TemplateRequest, "$schema" | "contract">;

/**
 * Why a request is refused. `invalid` is a document the schema refuses for
 * a reason no other code names (a missing field, a `via` it does not know).
 */
export type TemplateRequestRefusalCode =
  | "unknown-version"
  | "not-active"
  | "unsigned"
  | "unknown-input"
  | "missing-input"
  | "sensitive-input"
  | "input-type"
  | "bad-name"
  | "invalid";

/** Every refusal code, in the order {@link checkTemplateRequest} checks them. */
export const TEMPLATE_REQUEST_REFUSAL_CODES: readonly TemplateRequestRefusalCode[] = [
  "bad-name",
  "invalid",
  "unknown-version",
  "not-active",
  "unsigned",
  "unknown-input",
  "sensitive-input",
  "input-type",
  "missing-input",
];

/** One refusal: its code, the request field it is about, and a sentence naming that field. */
export interface TemplateRequestRefusal {
  code: TemplateRequestRefusalCode;
  /** `app`, `addon`, `version`, `inputs.<name>`, or the schema path for `invalid`. */
  field: string;
  reason: string;
}

export type TemplateRequestCheck = { ok: true; request: TemplateRequest } | { ok: false; refusals: TemplateRequestRefusal[] };

export interface CheckTemplateRequestOptions {
  /**
   * The catalog component the template is. Absent: the component named
   * `request.template`. A product that lists components by path looks the
   * address up itself and passes the name here.
   */
  component?: string;
  /** The lowest attestation a version may have. Default `signed`; `unsigned` accepts any. */
  require?: AttestationState;
}

const ATTESTATION_RANK: Record<AttestationState, number> = { unsigned: 0, signed: 1, verified: 2 };

/** Fill `$schema` and `contract` into a request. */
export function makeTemplateRequest(input: TemplateRequestInput): TemplateRequest {
  const { kind, template, version, app, addon, inputs, requestedBy, via } = input;
  return {
    $schema: TEMPLATE_REQUEST_SCHEMA_ID,
    contract: TEMPLATE_REQUEST_CONTRACT,
    kind,
    template,
    version,
    app,
    ...(addon !== undefined ? { addon } : {}),
    inputs,
    requestedBy,
    via,
  };
}

/** The schema problems of a request document, one line each; empty when it is valid. */
export function validateTemplateRequest(doc: unknown): string[] {
  return schemaProblems(TEMPLATE_REQUEST_SCHEMA_ID, doc);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Check a request against the catalog and the version's template.yml.
 * Returns every refusal, each with its code and a reason naming the field.
 * A bad name or a document the schema refuses stops the check there, and so
 * does a version the catalog does not list; past that, the version's status
 * and attestation and each input are all checked.
 */
export function checkTemplateRequest(
  request: unknown,
  catalog: ReleaseCatalog,
  templateSpec: TemplateSpec,
  options: CheckTemplateRequestOptions = {},
): TemplateRequestCheck {
  const refused = (refusals: TemplateRequestRefusal[]): TemplateRequestCheck => ({ ok: false, refusals });

  // Names first, so a bad one reads as bad-name and not as a schema pattern.
  const names: TemplateRequestRefusal[] = [];
  const probe: Record<string, unknown> = isRecord(request) ? { ...request } : {};
  for (const field of ["app", "addon"] as const) {
    const v = probe[field];
    if (typeof v !== "string" || REQUEST_NAME_PATTERN.test(v)) continue;
    names.push({
      code: "bad-name",
      field,
      reason: `${field} ${JSON.stringify(v)} is not a name: a lowercase letter, then up to 39 lowercase letters, digits and -`,
    });
    probe[field] = "x";
  }
  if (names.length > 0) return refused(names);

  const problems = validateTemplateRequest(isRecord(request) ? probe : request);
  if (problems.length > 0) {
    return refused(problems.map((p) => ({ code: "invalid", field: p.split(" ")[0]!, reason: `the request ${p}` })));
  }
  const req = request as TemplateRequest;

  const componentName = options.component ?? req.template;
  const component: CatalogComponent | undefined = catalog.components.find((c) => c.name === componentName);
  if (!component) {
    return refused([{ code: "unknown-version", field: "version", reason: `version ${JSON.stringify(req.version)}: the catalog lists no template ${JSON.stringify(componentName)}` }]);
  }
  const version = catalogVersion(catalog, component.name, req.version);
  if (!version) {
    const listed = component.versions.map((v) => v.version ?? v.digest).join(", ") || "none";
    return refused([{ code: "unknown-version", field: "version", reason: `version ${JSON.stringify(req.version)} of ${req.template} is not in the catalog (it lists ${listed})` }]);
  }

  const refusals: TemplateRequestRefusal[] = [];
  if (version.status.state !== "active") {
    const instead = version.status.replacement ? `; use ${version.status.replacement}` : "";
    refusals.push({ code: "not-active", field: "version", reason: `version ${req.version} of ${req.template} is ${version.status.state}${instead}` });
  }
  const require = options.require ?? "signed";
  if (ATTESTATION_RANK[version.attestation.state] < ATTESTATION_RANK[require]) {
    refusals.push({ code: "unsigned", field: "version", reason: `version ${req.version} of ${req.template} is ${version.attestation.state}, and requests need ${require}` });
  }

  const byName = new Map(templateSpec.inputs.map((i) => [i.name, i]));
  for (const [name, value] of Object.entries(req.inputs)) {
    const field = `inputs.${name}`;
    const input = byName.get(name);
    if (!input) {
      refusals.push({ code: "unknown-input", field, reason: `${field}: ${req.template} ${req.version} has no input ${JSON.stringify(name)}` });
      continue;
    }
    if (input.sensitive) {
      refusals.push({ code: "sensitive-input", field, reason: `${field} is sensitive, and a request is written into a pull request; the app reads it from its secret store` });
      continue;
    }
    const p = inputKindProblem(input, value);
    if (p) refusals.push({ code: "input-type", field, reason: `${field} ${p}` });
  }
  for (const input of templateSpec.inputs) {
    if (input.sensitive || !inputRequired(input) || input.name in req.inputs) continue;
    refusals.push({ code: "missing-input", field: `inputs.${input.name}`, reason: `inputs.${input.name} is required by ${req.template} ${req.version} and the request gives none` });
  }

  return refusals.length > 0 ? refused(refusals) : { ok: true, request: req };
}

/**
 * A template's name as a branch uses it: the second-to-last segment of an
 * address with three or more (`acme/bucket/aws` is `bucket`), else the last.
 */
export function templateName(template: string): string {
  const parts = template.split("/").filter(Boolean);
  return (parts.length >= 3 ? parts[parts.length - 2] : parts[parts.length - 1]) ?? template;
}

/** The request's branch: `request/<template-name>/<app>`, and `/<addon>` after it for an add-on. */
export function requestBranch(request: Pick<TemplateRequest, "template" | "app"> & Partial<Pick<TemplateRequest, "kind" | "addon">>): string {
  const base = `request/${templateName(request.template)}/${request.app}`;
  return request.addon !== undefined ? `${base}/${request.addon}` : base;
}
