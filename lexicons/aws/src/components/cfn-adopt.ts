/**
 * Adopting indexed resources into a CloudFormation stack (#4536; design and
 * ruling on INTENTIUS/choudoufu#2284, 2026-10-26).
 *
 * The aws lexicon deploys CREATE and UPDATE change sets. A CREATE of a
 * template that declares an existing bucket fails, so adoption takes two
 * change sets:
 *
 * 1. IMPORT, with the template's markers left out. CloudFormation import
 *    brings a resource under the stack without applying the template's
 *    property values, so markers in the import template would never be
 *    written, and the next UPDATE would then see no change and not write them
 *    either. The import template also carries no stack tags.
 * 2. UPDATE, with the template as built: it adds chant's marker tags to each
 *    imported resource and the stack's own tags. It must be tags only: a
 *    change to anything but the tag property, a replace, an add or a remove
 *    refuses the run before it executes.
 *
 * The gate is chant's change-set review (Q3): each change set is shown before
 * it is executed, through the caller's `review`, and the marker review lists
 * each marker write as tags only. Nothing here asks a question of its own.
 *
 * Refused before any change set is made ({@link planCfnAdoption}): an
 * adoption file that does not match its index version, a node the template
 * does not declare under the file's `as`, a type CloudFormation cannot import
 * or whose tags can only be set at create (../importable.ts), a resource with
 * no DeletionPolicy (import needs one; `chant import --index` writes Retain,
 * Q4), a resource already in the stack, and a template that would also create
 * a resource. The index proposes; the live read decides: CloudFormation reads
 * each object again when it imports it, by the identifier given here.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptionFileProblemsAgainst, type AdoptionFile } from "@intentius/chant/lifecycle/adoption-file";
import type { IndexDocument } from "@intentius/chant/lifecycle/index-document";
import { adoptionRefusal, importabilityManifest, type ImportabilityManifestEntry } from "../importable";
import { AWS_TAG_OWNERSHIP_KEYS, OWNERSHIP_METADATA_KEY } from "../ownership";
import { isNoopChangeSet } from "./apply";
import type { CfnChange, CfnChangeSet, CfnResourceToImport, CloudFormationClient } from "./cloud-executor";

/** A CloudFormation template as chant builds it. */
export interface CfnTemplate {
  Metadata?: Record<string, unknown>;
  Resources: Record<string, { Type: string; Properties?: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** One resource the adoption brings under the stack. */
export interface CfnAdoptedResource {
  node: string;
  logicalId: string;
  type: string;
  identifier: Record<string, string>;
  deletionPolicy: string;
  /** The property the markers are written to, when the type has one chant can stamp. */
  tagProperty?: string;
  /** The marker tags the UPDATE writes. Empty for a type chant cannot tag. */
  markers: Record<string, string>;
}

export interface CfnAdoptionPlan {
  /** Why the adoption cannot run, each by name. Empty when it can. */
  refusals: string[];
  resources: CfnAdoptedResource[];
  /** The IMPORT change set's template: the built one without markers or stack tags. */
  importTemplate: CfnTemplate;
  /** The UPDATE change set's template: the built one. */
  markerTemplate: CfnTemplate;
}

export interface PlanCfnAdoptionInput {
  /** The built template of the stack the resources join, from the source `chant import --index` wrote. */
  template: CfnTemplate;
  adoption: AdoptionFile;
  /** The index version the adoption file names. */
  index: IndexDocument;
  /** Logical ids already in the stack (empty for a new stack). */
  existing?: ReadonlySet<string>;
  manifest?: ReadonlyMap<string, ImportabilityManifestEntry>;
}

const MARKER_KEYS: ReadonlySet<string> = new Set(Object.values(AWS_TAG_OWNERSHIP_KEYS));

/** The marker tags in a tag property's value, and the value without them. */
function splitMarkers(tags: unknown, shape: "list" | "map" | undefined): { markers: Record<string, string>; rest: unknown } {
  const markers: Record<string, string> = {};
  if (Array.isArray(tags) && shape !== "map") {
    const rest = tags.filter((t) => {
      const key = (t as { Key?: unknown })?.Key;
      const value = (t as { Value?: unknown })?.Value;
      if (typeof key === "string" && MARKER_KEYS.has(key)) {
        if (typeof value === "string") markers[key] = value;
        return false;
      }
      return true;
    });
    return { markers, rest };
  }
  if (tags && typeof tags === "object" && !Array.isArray(tags)) {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tags as Record<string, unknown>)) {
      if (MARKER_KEYS.has(k)) {
        if (typeof v === "string") markers[k] = v;
      } else rest[k] = v;
    }
    return { markers, rest };
  }
  return { markers, rest: tags };
}

const isEmpty = (v: unknown): boolean =>
  v === undefined || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/** The import identifier: the type's primary identifier properties zipped with the native id split on `|`. */
export function cfnResourceIdentifier(primaryIdentifier: readonly string[], nativeId: string): Record<string, string> | undefined {
  const parts = nativeId.split("|");
  if (primaryIdentifier.length === 0 || parts.length !== primaryIdentifier.length) return undefined;
  return Object.fromEntries(primaryIdentifier.map((p, i) => [p, parts[i]!]));
}

/** Plan an adoption. Pure: reads nothing from the cloud. */
export function planCfnAdoption(input: PlanCfnAdoptionInput): CfnAdoptionPlan {
  const manifest = input.manifest ?? importabilityManifest();
  const existing = input.existing ?? new Set<string>();
  const refusals = adoptionFileProblemsAgainst(input.adoption, input.index);
  const nodes = new Map(input.index.graph.nodes.map((n) => [n.id, n]));
  const importTemplate = JSON.parse(JSON.stringify(input.template)) as CfnTemplate;
  const markerTemplate = JSON.parse(JSON.stringify(input.template)) as CfnTemplate;
  const resources: CfnAdoptedResource[] = [];
  const adopted = new Set<string>();

  for (const sel of input.adoption.select ?? []) {
    const node = nodes.get(sel.node);
    if (!node) continue; // adoptionFileProblemsAgainst names it
    const logicalId = sel.as;
    adopted.add(logicalId);
    const resource = input.template.Resources?.[logicalId];
    if (!resource) {
      refusals.push(`${sel.node}: the template declares no resource ${logicalId}`);
      continue;
    }
    const type = resource.Type;
    if (type !== node.kind) refusals.push(`${logicalId}: the template declares ${type}, but ${sel.node} is ${node.kind}`);
    if (sel.type !== undefined && sel.type !== type) refusals.push(`${logicalId}: the adoption file names type ${sel.type}, but the template declares ${type}`);
    const refusal = adoptionRefusal(type, manifest);
    if (refusal) refusals.push(`${logicalId}: ${refusal}`);
    if (existing.has(logicalId)) refusals.push(`${logicalId} is already in the stack; nothing to import`);
    const deletionPolicy = resource.DeletionPolicy;
    if (typeof deletionPolicy !== "string") {
      refusals.push(`${logicalId} declares no DeletionPolicy; CloudFormation import needs one (chant import --index writes Retain)`);
    }
    const entry = manifest.get(type);
    const identifier = cfnResourceIdentifier(entry?.primaryIdentifier ?? [], node.nativeId ?? "");
    if (!identifier) {
      refusals.push(
        `${logicalId}: native id "${node.nativeId ?? ""}" does not split into ${type}'s primary identifier (${(entry?.primaryIdentifier ?? []).join(", ") || "none"})`,
      );
    }
    const tagProperty = entry?.tagging?.taggable ? entry.tagging.tagProperty : undefined;
    let markers: Record<string, string> = {};
    if (tagProperty) {
      const props = importTemplate.Resources[logicalId]!.Properties ?? {};
      const split = splitMarkers(props[tagProperty], entry?.tagging?.tagShape);
      markers = split.markers;
      if (isEmpty(split.rest)) delete props[tagProperty];
      else props[tagProperty] = split.rest;
      importTemplate.Resources[logicalId]!.Properties = props;
    }
    resources.push({
      node: sel.node,
      logicalId,
      type,
      identifier: identifier ?? {},
      deletionPolicy: typeof deletionPolicy === "string" ? deletionPolicy : "",
      ...(tagProperty ? { tagProperty } : {}),
      markers,
    });
  }

  for (const id of Object.keys(input.template.Resources ?? {}).sort()) {
    if (!adopted.has(id) && !existing.has(id)) {
      refusals.push(`the template also creates ${id}; adopt first, then add it in a later deploy (the marker UPDATE must be tags only)`);
    }
  }

  // No stack tags on the IMPORT: the UPDATE writes them with the resource markers.
  if (importTemplate.Metadata && OWNERSHIP_METADATA_KEY in importTemplate.Metadata) {
    delete importTemplate.Metadata[OWNERSHIP_METADATA_KEY];
    if (Object.keys(importTemplate.Metadata).length === 0) delete importTemplate.Metadata;
  }

  resources.sort((a, b) => (a.logicalId < b.logicalId ? -1 : a.logicalId > b.logicalId ? 1 : 0));
  return { refusals, resources, importTemplate, markerTemplate };
}

/** What the IMPORT change set's review shows, one line per resource. */
export function cfnImportReview(plan: CfnAdoptionPlan): string[] {
  return plan.resources.map(
    (r) =>
      `import ${r.logicalId} (${r.type}) ${Object.entries(r.identifier).map(([k, v]) => `${k}=${v}`).join(" ")}, DeletionPolicy ${r.deletionPolicy}`,
  );
}

/** What the marker UPDATE's review shows: each marker write, as tags only. */
export function cfnMarkerReview(plan: CfnAdoptionPlan): string[] {
  return plan.resources.map((r) =>
    Object.keys(r.markers).length > 0 && r.tagProperty
      ? `marker write, tags only: ${r.logicalId} (${r.type}) ${r.tagProperty} += ${Object.entries(r.markers)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}`
      : r.tagProperty
        ? `no marker: ${r.logicalId} (${r.type}) carries no chant marker in the template; the stack owns it on its template alone`
        : `no marker: ${r.logicalId} (${r.type}) has no tags chant can stamp; the stack owns it on its template alone`,
  );
}

/** Why an IMPORT change set is not the one planned, or empty. */
export function importChangeSetProblems(changeSet: CfnChangeSet, plan: CfnAdoptionPlan): string[] {
  const problems: string[] = [];
  if (changeSet.status === "FAILED") problems.push(`the IMPORT change set failed: ${changeSet.statusReason ?? "no reason given"}`);
  const want = new Set(plan.resources.map((r) => r.logicalId));
  const seen = new Set<string>();
  for (const c of changeSet.changes) {
    if (c.action !== "Import" || !want.has(c.logicalResourceId)) {
      problems.push(`the IMPORT change set would ${c.action.toLowerCase()} ${c.logicalResourceId} (${c.resourceType}), which the adoption does not import`);
    }
    seen.add(c.logicalResourceId);
  }
  for (const id of want) if (!seen.has(id) && changeSet.status !== "FAILED") problems.push(`the IMPORT change set does not import ${id}`);
  return problems;
}

function changeReplaces(c: CfnChange): boolean {
  return c.replacement || c.replacementMode === "True" || c.replacementMode === "Conditional";
}

/** Why the marker UPDATE is not tags only on the imported resources, or empty. */
export function markerChangeSetProblems(changeSet: CfnChangeSet, plan: CfnAdoptionPlan): string[] {
  const problems: string[] = [];
  if (changeSet.status === "FAILED" && !isNoopChangeSet(changeSet)) {
    problems.push(`the marker change set failed: ${changeSet.statusReason ?? "no reason given"}`);
  }
  const byId = new Map(plan.resources.map((r) => [r.logicalId, r]));
  for (const c of changeSet.changes) {
    const r = byId.get(c.logicalResourceId);
    if (c.action !== "Modify" || !r) {
      problems.push(`the marker change set would ${c.action.toLowerCase()} ${c.logicalResourceId} (${c.resourceType}); it may only add tags to the imported resources`);
      continue;
    }
    if (changeReplaces(c)) problems.push(`the marker change set would replace ${c.logicalResourceId} (${c.resourceType})`);
    const other = (c.details ?? []).filter((d) => d !== r.tagProperty);
    if (other.length > 0) problems.push(`the marker change set changes ${c.logicalResourceId}'s ${other.join(", ")}, not only its tags`);
  }
  return problems;
}

/** One change-set review: the step, the change set and what it writes. Approving executes it. */
export type CfnAdoptionReview = (step: "import" | "markers", changeSet: CfnChangeSet, lines: string[]) => Promise<boolean>;

export type CfnAdoptionOutcome =
  | { status: "adopted"; resources: CfnAdoptedResource[]; importChangeSet: string; markerChangeSet?: string }
  | { status: "refused"; step: "plan" | "import" | "markers"; refusals: string[] }
  | { status: "declined"; step: "import" | "markers" }
  | { status: "failed"; step: "import" | "markers"; stackStatus: string };

export interface AdoptIntoStackOptions {
  cfn: CloudFormationClient;
  stackName: string;
  plan: CfnAdoptionPlan;
  review: CfnAdoptionReview;
  parameters?: Record<string, string>;
  waitOptions?: { intervalMs?: number; timeoutMs?: number };
}

/**
 * Run a planned adoption: the IMPORT change set, its review and execution,
 * then the marker UPDATE, its tags-only check, review and execution. A
 * refusal or a declined review deletes the change set it made and stops. A
 * marker step that stops leaves the resources imported with Retain and
 * without markers; running the adoption's UPDATE again (a plain deploy of
 * the same template) writes them.
 */
export async function adoptIntoStack(opts: AdoptIntoStackOptions): Promise<CfnAdoptionOutcome> {
  const { cfn, stackName, plan, review } = opts;
  if (plan.refusals.length > 0) return { status: "refused", step: "plan", refusals: plan.refusals };
  if (plan.resources.length === 0) return { status: "refused", step: "plan", refusals: ["the adoption names no resource"] };
  if (!cfn.createImportChangeSet) {
    return { status: "refused", step: "plan", refusals: ["this CloudFormation client cannot create an IMPORT change set"] };
  }
  const dir = mkdtempSync(join(tmpdir(), "chant-cfn-adopt-"));
  try {
    const importPath = join(dir, "import.template.json");
    writeFileSync(importPath, JSON.stringify(plan.importTemplate, null, 2));
    const resourcesToImport: CfnResourceToImport[] = plan.resources.map((r) => ({
      resourceType: r.type,
      logicalResourceId: r.logicalId,
      resourceIdentifier: r.identifier,
    }));
    const imported = await cfn.createImportChangeSet({ stackName, templatePath: importPath, resourcesToImport, ...(opts.parameters ? { parameters: opts.parameters } : {}) });
    const ref = { stackName, changeSetName: imported.changeSetName };
    const importProblems = importChangeSetProblems(imported, plan);
    if (importProblems.length > 0) {
      await cfn.deleteChangeSet(ref);
      return { status: "refused", step: "import", refusals: importProblems };
    }
    if (!(await review("import", imported, cfnImportReview(plan)))) {
      await cfn.deleteChangeSet(ref);
      return { status: "declined", step: "import" };
    }
    await cfn.executeChangeSet(ref);
    const afterImport = await cfn.waitForStack(stackName, opts.waitOptions);
    if (afterImport.stackStatus !== "IMPORT_COMPLETE") return { status: "failed", step: "import", stackStatus: afterImport.stackStatus };

    const markerPath = join(dir, "markers.template.json");
    writeFileSync(markerPath, JSON.stringify(plan.markerTemplate, null, 2));
    const marked = await cfn.createChangeSet({ stackName, templatePath: markerPath, ...(opts.parameters ? { parameters: opts.parameters } : {}) });
    const markerRef = { stackName, changeSetName: marked.changeSetName };
    if (isNoopChangeSet(marked)) {
      await cfn.deleteChangeSet(markerRef);
      return { status: "adopted", resources: plan.resources, importChangeSet: imported.changeSetName };
    }
    const markerProblems = markerChangeSetProblems(marked, plan);
    if (markerProblems.length > 0) {
      await cfn.deleteChangeSet(markerRef);
      return { status: "refused", step: "markers", refusals: markerProblems };
    }
    if (!(await review("markers", marked, cfnMarkerReview(plan)))) {
      await cfn.deleteChangeSet(markerRef);
      return { status: "declined", step: "markers" };
    }
    await cfn.executeChangeSet(markerRef);
    const afterMarkers = await cfn.waitForStack(stackName, opts.waitOptions);
    if (afterMarkers.stackStatus !== "UPDATE_COMPLETE") return { status: "failed", step: "markers", stackStatus: afterMarkers.stackStatus };
    return { status: "adopted", resources: plan.resources, importChangeSet: imported.changeSetName, markerChangeSet: marked.changeSetName };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
