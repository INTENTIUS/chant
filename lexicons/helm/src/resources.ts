/**
 * Helm-specific resource and property types.
 *
 * Created via createResource/createProperty from @intentius/chant/runtime.
 * These are static types (no upstream schema to fetch).
 */

import { createResource, createProperty } from "@intentius/chant/runtime";

const LEXICON = "helm";

// ── Resources ─────────────────────────────────────────────

/**
 * Helm::Chart — Chart.yaml metadata.
 *
 * Defines the chart's identity: apiVersion, name, version, appVersion,
 * description, type (application|library), keywords, maintainers, dependencies.
 */
export const Chart = createResource("Helm::Chart", LEXICON, {});

/**
 * Helm::Values — Typed values definition.
 *
 * The props passed to the constructor become the default values emitted
 * in values.yaml. The serializer also generates values.schema.json from
 * the value types.
 */
export const Values = createResource("Helm::Values", LEXICON, {});

/**
 * Helm::Test — Helm test pod.
 *
 * Annotated with `helm.sh/hook: test` in the serialized output.
 * Props should contain a K8s Pod spec.
 */
export const HelmTest = createResource("Helm::Test", LEXICON, {});

/**
 * Helm::Notes — NOTES.txt template content.
 *
 * The `content` prop is emitted as templates/NOTES.txt.
 */
export const HelmNotes = createResource("Helm::Notes", LEXICON, {});

// ── Property types ────────────────────────────────────────

/**
 * Helm::Hook — Lifecycle hook annotation.
 *
 * Wraps a K8s resource with helm.sh/hook annotations.
 * Props: { hook: string, weight?: number, deletePolicy?: string, resource: Declarable }
 */
export const HelmHook = createProperty("Helm::Hook", LEXICON);

/**
 * Helm::Dependency — Chart dependency entry.
 *
 * Props: { name, version, repository, condition?, tags?, enabled?, importValues?, alias? }
 */
export const HelmDependency = createProperty("Helm::Dependency", LEXICON);

/**
 * Helm::Maintainer — Chart maintainer entry.
 *
 * Props: { name, email?, url? }
 */
export const HelmMaintainer = createProperty("Helm::Maintainer", LEXICON);
