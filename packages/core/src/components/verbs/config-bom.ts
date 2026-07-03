/**
 * `extract-config-bom` capability (#613, epic #551 follow-up to #606).
 *
 * chant synthesis is deterministic, so a synthesized IaC template (the
 * CloudFormation JSON `chant build` already produces — see ../../build.ts
 * and lexicons/aws/src/serializer.ts's `CFTemplate`) is itself a
 * reproducible artifact with a legitimate bill-of-materials: it declares
 * resources, may nest child stacks, and references external artifacts
 * (container image digests, AMI ids, other lexicons' versions) that are not
 * declared dependencies in any lockfile. This module is the config-BOM
 * analogue of ./sbom.ts's `generate-sbom`: same archive/manifest wiring,
 * same SPDX/CycloneDX writer (./bom-writer.ts), different subject (a
 * template's structure instead of a lockfile's package list).
 *
 * **Scope.** The extractor is a pure, hermetic AST-ish walk over the
 * template's already-parsed JSON — no cloud calls, no `cfn describe-stacks`,
 * no network. It only reads chant's own synthesized output, so it works
 * identically for any lexicon whose serializer emits a JSON document shaped
 * like CloudFormation's `{ Resources: { name: { Type, Properties } } }` (the
 * ../../serializer.ts `SerializerResult.primary`/`files` convention every
 * lexicon serializer already produces). Non-JSON serializer output (a raw
 * Kubernetes YAML manifest, say) is out of scope for this first cut — see
 * `extractConfigBom`'s doc comment.
 *
 * **Why config-only/infra components get a BOM.** #606 shipped
 * `generate-sbom` keyed to *artifact* types (image/jar/zip/dir); a
 * config-only component (no `build` phase, e.g. a DynamoDB table or an EMR
 * cluster definition — see epic #551's "Infra" archetype) has none of those
 * and so was previously assumed to have nothing to attach a BOM to. That
 * assumption undercounts what's true: the synthesized template *is* that
 * component's build output. Treating it as a first-class archive artifact
 * (a `template`-kind entry with its own content digest, peer to `image`/
 * `asset` — see ./build-archive.ts's `addArchiveTemplate`) means a
 * config-BOM can attach to it exactly the way a software SBOM attaches to
 * an image digest, closing the gap.
 */

import type { Capability } from "../capability";
import {
  addArchiveEntry,
  archiveRelativePath,
  contentDigest,
  createBuildArchiveManifest,
  type BuildArchiveManifest,
} from "./build-archive";
import { writeBom, type BomPackage } from "./bom-writer";
import { DEFAULT_SBOM_FORMAT, type SbomDocument, type SbomFormat } from "./sbom-generator";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// ── template model (subset of CFTemplate this extractor needs) ─────────────

interface TemplateResource {
  Type?: string;
  Properties?: Record<string, unknown>;
}

interface SynthesizedTemplate {
  Resources?: Record<string, TemplateResource>;
  Outputs?: Record<string, unknown>;
}

/** One external reference a template's resources point at — an image digest, an AMI id, or another lexicon's declared version. Enumerated separately from declared resources since these aren't things chant itself owns/synthesizes. */
export interface ExternalReference {
  kind: "image-digest" | "ami" | "lexicon-version";
  /** The reference value itself (a digest, an AMI id, a version string). */
  value: string;
  /** Logical resource name the reference was found on, when known. */
  resourceName?: string;
}

/** One nested stack/module a template references (an `AWS::CloudFormation::Stack` resource, or the equivalent nesting concept in another lexicon). */
export interface NestedStackReference {
  /** Logical name of the nesting resource in the parent template. */
  resourceName: string;
  /** Referenced child template's filename/path, when the parent's `Properties` names one (e.g. CFN's `TemplateURL`). */
  templatePath?: string;
}

/** Structural summary produced by walking a synthesized template — the data `extractConfigBom` projects into a `BomPackage[]` for the SPDX/CycloneDX writer. */
export interface ConfigBomInventory {
  /** Every declared resource, keyed by logical name, with its CFN-style `Type` (e.g. `"AWS::S3::Bucket"`). */
  resources: Array<{ name: string; type: string }>;
  /** Nested stacks/modules this template declares. */
  nestedStacks: NestedStackReference[];
  /** External artifacts referenced by any resource (image digests, AMIs, lexicon versions). */
  externalReferences: ExternalReference[];
}

/** CloudFormation resource type used for nested stacks (see lexicons/aws/src/nested-stack.ts). Other lexicons' nesting resource types can be added here as they gain the same concept. */
const NESTED_STACK_TYPES = new Set(["AWS::CloudFormation::Stack"]);

/** Property names known to carry a nested stack's child template location, checked in order. */
function extractTemplatePath(properties: Record<string, unknown> | undefined): string | undefined {
  const templateUrl = properties?.TemplateURL;
  if (typeof templateUrl === "string") return templateUrl;
  if (templateUrl && typeof templateUrl === "object") {
    // { "Fn::Sub": "${TemplateBasePath}/network.template.json" } — pull the filename back out.
    const sub = (templateUrl as Record<string, unknown>)["Fn::Sub"];
    if (typeof sub === "string") {
      const match = sub.match(/([^/{}$]+\.template\.json)$/);
      if (match) return match[1];
    }
  }
  return undefined;
}

/** AMI id pattern (`ami-` followed by 8 or 17 hex chars, matching both legacy and current EC2 id formats). */
const AMI_PATTERN = /^ami-[0-9a-f]{8}([0-9a-f]{9})?$/;
/** OCI/Docker content digest pattern (`sha256:<64 hex chars>`), the same form ./build-archive.ts's `contentDigest` produces. */
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** A bare `image:tag@sha256:digest` or `image@sha256:digest` reference. */
const IMAGE_DIGEST_REF_PATTERN = /@(sha256:[0-9a-f]{64})$/;

/** Property names likely to carry a lexicon version string, so a bare semver value there is attributed as `lexicon-version` rather than left unclassified. */
const LEXICON_VERSION_PROPERTY_NAMES = new Set(["LexiconVersion", "lexiconVersion", "ChantLexiconVersion"]);

/** Walk one resource's `Properties` tree (recursively, since a reference can be nested inside e.g. a container definition list) collecting external references. */
function scanPropertiesForReferences(
  resourceName: string,
  properties: unknown,
  propertyKeyHint: string | undefined,
  out: ExternalReference[],
): void {
  if (properties === null || properties === undefined) return;
  if (typeof properties === "string") {
    if (AMI_PATTERN.test(properties)) {
      out.push({ kind: "ami", value: properties, resourceName });
    } else if (DIGEST_PATTERN.test(properties) || IMAGE_DIGEST_REF_PATTERN.test(properties)) {
      const digestMatch = properties.match(IMAGE_DIGEST_REF_PATTERN);
      out.push({ kind: "image-digest", value: digestMatch ? digestMatch[1]! : properties, resourceName });
    } else if (propertyKeyHint && LEXICON_VERSION_PROPERTY_NAMES.has(propertyKeyHint) && /^\d+\.\d+\.\d+/.test(properties)) {
      out.push({ kind: "lexicon-version", value: properties, resourceName });
    }
    return;
  }
  if (Array.isArray(properties)) {
    for (const item of properties) scanPropertiesForReferences(resourceName, item, propertyKeyHint, out);
    return;
  }
  if (typeof properties === "object") {
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      scanPropertiesForReferences(resourceName, value, key, out);
    }
  }
}

/**
 * Walk a synthesized template's parsed JSON, enumerating declared resources,
 * nested stack/module references, and external artifact references (image
 * digests, AMI ids, lexicon versions found in resource properties).
 *
 * Deliberately structural, not semantic: this never talks to AWS/any cloud
 * to resolve what an AMI id or image digest actually *is* — it only records
 * that a resource's properties reference one, the same "surface the
 * reference, don't interpret it" stance ./sbom-generator.ts's module doc
 * takes for SBOM content generally.
 */
export function inventoryTemplate(templateJson: string): ConfigBomInventory {
  const template: SynthesizedTemplate = JSON.parse(templateJson);
  const resources: Array<{ name: string; type: string }> = [];
  const nestedStacks: NestedStackReference[] = [];
  const externalReferences: ExternalReference[] = [];

  for (const [name, resource] of Object.entries(template.Resources ?? {})) {
    const type = resource.Type ?? "Unknown";
    resources.push({ name, type });

    if (NESTED_STACK_TYPES.has(type)) {
      nestedStacks.push({ resourceName: name, templatePath: extractTemplatePath(resource.Properties) });
    }

    scanPropertiesForReferences(name, resource.Properties, undefined, externalReferences);
  }

  return { resources, nestedStacks, externalReferences };
}

/** Project a `ConfigBomInventory` into the standard-agnostic `BomPackage[]` shape ./bom-writer.ts's writers consume. Every declared resource becomes a `type: "config"` component; every external reference becomes a `type: "external-reference"` component, so a config-BOM reader sees "what chant declared" and "what chant points at but doesn't own" as distinguishable entries rather than a flat, ambiguous list. */
export function inventoryToBomPackages(inventory: ConfigBomInventory): BomPackage[] {
  const resourcePackages: BomPackage[] = inventory.resources.map((r) => ({
    name: r.name,
    version: r.type,
    type: "config",
  }));
  const nestedStackNames = new Set(inventory.nestedStacks.map((n) => n.resourceName));
  for (const pkg of resourcePackages) {
    if (nestedStackNames.has(pkg.name)) {
      const nested = inventory.nestedStacks.find((n) => n.resourceName === pkg.name);
      if (nested?.templatePath) pkg.purl = `chant:nested-stack/${nested.templatePath}`;
    }
  }
  const referencePackages: BomPackage[] = inventory.externalReferences.map((ref, i) => ({
    name: `${ref.kind}:${ref.resourceName ?? "unknown"}:${i}`,
    version: ref.value,
    type: "external-reference",
  }));
  return [...resourcePackages, ...referencePackages];
}

// ── extract-config-bom capability ───────────────────────────────────────────

export interface ExtractConfigBomInput {
  /** Archive-relative (or local) path to the synthesized template being scanned — the `template` archive entry's `path`. An `archive:`-prefixed reference is accepted and stripped, matching `generate-sbom`'s `path` convention. */
  path: string;
  /** Serialized template content (the same bytes `addArchiveTemplate`, ./build.ts, was/will be given) — this capability never reads from disk itself, keeping it pure/hermetic and testable with an in-memory fixture. */
  content: string;
  /** Digest of the `template` archive entry this config-BOM describes (see ./build-archive.ts's `contentDigest`). Omitted when scanning a template ahead of it being archived. */
  digest?: string;
  /** BOM format to emit. Defaults to `DEFAULT_SBOM_FORMAT` (SPDX), same precedence story as `generate-sbom` (see ../../config.ts's `resolveSbomFormat`). */
  format?: SbomFormat;
  /** Where the config-BOM document is written inside the build archive. Defaults to `<path>.config-bom.json`. */
  into?: string;
  /** Manifest to extend, so a component's whole build phase (template + config-BOM, alongside any image + software SBOM) accumulates one manifest — same accumulation convention as `generate-sbom`'s `manifest` input. */
  manifest?: BuildArchiveManifest;
  /** Directory to also write the config-BOM document to on disk, mirroring the software SBOM's `sbom.<format>.json` convention (see ./lockfile-sbom-generator.ts's `sbomOutputPath`). Omitted: archive-only, no disk write (useful in tests). */
  outDir?: string;
  /** Clock override for deterministic tests. */
  now?: () => Date;
}

export interface ExtractConfigBomOutput {
  /** The generated config-BOM document (format, media type, bytes, package count, generator — reuses `SbomDocument`'s shape since a config-BOM is structurally the same kind of document as a software SBOM). */
  bom: SbomDocument;
  /** Structural inventory this config-BOM was derived from — resources, nested stacks, external references — surfaced directly so a caller/test can assert on template structure without re-parsing the BOM bytes. */
  inventory: ConfigBomInventory;
  /** Where the config-BOM was written inside the build archive. */
  archivePath: string;
  /** Content-addressed digest of the config-BOM document's own bytes. */
  digest: string;
  /** The build archive's manifest, now including this config-BOM's entry (`kind: "sbom"`, `bomKind: "config"`) alongside whatever `input.manifest` already held. */
  manifest: BuildArchiveManifest;
}

/** Default archive path for a generated config-BOM when `into` is omitted: `<template path>.config-bom.json`. */
function defaultConfigBomPath(templatePath: string): string {
  return `${archiveRelativePath(templatePath)}.config-bom.json`;
}

/** Tool name recorded on the archive entry / BOM document — surfaced the same way `generate-sbom` records `sbom.generator` (e.g. "syft-1.2.3"). */
const CONFIG_BOM_GENERATOR = "chant-config-bom-extractor";

/**
 * Extract a config-BOM from a synthesized IaC template's declared resources,
 * nested stacks, and external references, and fold the result into the
 * build-archive manifest as an `sbom`-kind entry (`bomKind: "config"`) linked
 * to the template artifact's digest — the config-BOM peer of `generate-sbom`
 * (./sbom.ts). No rollback, for the same reason `generate-sbom` declares
 * none: an already-generated, content-addressed BOM is evidence, not mutable
 * state to compensate.
 */
export function createExtractConfigBomCapability(): Capability<ExtractConfigBomInput, ExtractConfigBomOutput> {
  return {
    kind: "extract-config-bom",
    async run(ctx, input) {
      const templatePath = archiveRelativePath(input.path);
      const format = input.format ?? DEFAULT_SBOM_FORMAT;
      const inventory = inventoryTemplate(input.content);
      const packages = inventoryToBomPackages(inventory);

      const doc = writeBom(
        format,
        {
          subjectName: templatePath,
          subjectId: input.digest ?? contentDigest(input.content),
          packages,
          generator: CONFIG_BOM_GENERATOR,
        },
        input.now,
      );
      const bom: SbomDocument = { ...doc, packageCount: packages.length, generator: CONFIG_BOM_GENERATOR };

      if (input.outDir) {
        mkdirSync(input.outDir, { recursive: true });
        writeFileSync(join(input.outDir, `config-bom.${format}.json`), bom.bytes);
      }

      const into = input.into ?? defaultConfigBomPath(input.path);
      const digest = contentDigest(bom.bytes);
      const base = input.manifest ?? createBuildArchiveManifest(ctx.component);
      const manifest = addArchiveEntry(base, {
        kind: "sbom",
        bomKind: "config",
        path: into,
        digest,
        mediaType: bom.mediaType,
        subjectDigest: input.digest,
        packageCount: bom.packageCount,
        generator: bom.generator,
      });

      return { bom, inventory, archivePath: into, digest, manifest };
    },
  };
}

/**
 * Default `extract-config-bom` capability. Pure/hermetic — no injectable
 * backend needed since template inventory is a structural walk, not a scan
 * requiring an external tool.
 *
 * Typically composed immediately after `addArchiveTemplate` (./build.ts) in
 * a config-only/infra component's build phase — `addArchiveTemplate` folds
 * the synthesized template into the archive as a first-class `template`-kind
 * entry with its own content digest (#613 — IaC as a first-class build
 * artifact, peer to `image`/`jar`), and this capability attaches the
 * resulting config-BOM to that same digest.
 */
export const extractConfigBom: Capability<ExtractConfigBomInput, ExtractConfigBomOutput> =
  createExtractConfigBomCapability();
