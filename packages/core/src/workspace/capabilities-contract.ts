/**
 * The `capabilities` document of the read contract (#4375, ws-017): the
 * capability catalog `chant search` answers `cap:` terms with, described by
 * `capabilities.schema.json` beside this file.
 *
 * `chant search --capabilities --json` prints it for one project, with a
 * support statement for each lexicon the project loads. `chant workspace
 * search --capabilities --json` prints it from the workspace root's chant,
 * for every lexicon a member loads (a terraform member's reader lexicon
 * included, #4380): capability rules run once, under
 * the workspace's chant, so the catalog is that chant's. chant's MCP
 * `capabilities` tool returns whichever of the two applies where the server
 * runs, unchanged.
 */

import { resolve } from "node:path";
import type { ReasonCode } from "./reason-codes";
import type { CapabilityEntry } from "../capabilities/catalog";
import type { TemplateEntry } from "../capabilities/templates";

/** The version of the `capabilities` document this chant writes. */
export const CAPABILITIES_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for the document, shipped beside this file. */
export const CAPABILITIES_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/capabilities/v1/capabilities.schema.json";

/** Why no catalog was printed. */
export const CAPABILITIES_ERROR_CODES = ["usage-invalid"] as const satisfies readonly ReasonCode[];
export type CapabilitiesErrorCode = (typeof CAPABILITIES_ERROR_CODES)[number];

/** Why a lexicon can't supply a capability. */
export const CAPABILITY_SUPPORT_CODES = ["lexicon-has-no-mapping", "capability-not-derivable", "lexicon-not-loaded"] as const satisfies readonly ReasonCode[];

interface CapabilitiesHead {
  $schema: typeof CAPABILITIES_OUTPUT_SCHEMA_ID;
  contract: typeof CAPABILITIES_CONTRACT_VERSION;
  /** The chant that wrote the document. */
  chant: string;
}

export interface CapabilitiesResult extends CapabilitiesHead {
  capabilities: CapabilityEntry[];
  helpers: { name: string; rule: string }[];
  /**
   * The investigation templates (#4531), the catalog's second kind of entry.
   * Added within contract 1; a document from a chant older than
   * CAPABILITY_TEMPLATES_FLOOR lacks it.
   */
  templates: TemplateEntry[];
}

export interface CapabilitiesFailure extends CapabilitiesHead {
  error: { code: CapabilitiesErrorCode; message: string; hint?: string };
}

export type CapabilitiesDocument = CapabilitiesResult | CapabilitiesFailure;

async function head(): Promise<CapabilitiesHead> {
  const { readChantPackageVersion } = await import("../package-version");
  return { $schema: CAPABILITIES_OUTPUT_SCHEMA_ID, contract: CAPABILITIES_CONTRACT_VERSION, chant: readChantPackageVersion() };
}

/**
 * The catalog, with a support statement for each lexicon named. Each is
 * loaded on its own, so one that isn't installed is said to be, and the rest
 * still read.
 */
export async function capabilitiesDocument(
  lexicons: string[],
  load?: (name: string) => Promise<{ capabilityPack?: { mapping: unknown } }>,
): Promise<CapabilitiesResult> {
  const loadPlugin = load ?? (await import("../cli/plugins")).loadPlugin;
  const { capabilityCatalog } = await import("../capabilities/catalog");
  const mappings: Record<string, Parameters<typeof capabilityCatalog>[0][string]> = {};
  const notLoaded: string[] = [];
  for (const name of [...new Set(lexicons)].sort()) {
    try {
      mappings[name] = (await loadPlugin(name)).capabilityPack?.mapping as (typeof mappings)[string];
    } catch {
      notLoaded.push(name);
      mappings[name] = undefined;
    }
  }
  const { investigationTemplates } = await import("../capabilities/templates");
  const catalog = capabilityCatalog(mappings);
  for (const c of catalog.capabilities) {
    for (const name of notLoaded) {
      c.lexicons[name] = { code: "lexicon-not-loaded", message: `the ${name} lexicon isn't installed where this chant runs, so its mapping wasn't read` };
    }
  }
  return { ...(await head()), ...catalog, templates: investigationTemplates() };
}

export async function capabilitiesFailure(error: CapabilitiesFailure["error"]): Promise<CapabilitiesFailure> {
  return { ...(await head()), error };
}

/**
 * The lexicons the members of the workspace at `cwd` load, for its catalog:
 * each chant member's own, and for a member of a package's kind, such as
 * `terraform`, the lexicon its reader project declares (#4380).
 */
export async function workspaceLexicons(cwd: string): Promise<string[]> {
  const { listWorkspace } = await import("./ls");
  const { findWorkspaceRoot } = await import("../project-root");
  const { resolveProjectLexicons } = await import("../cli/plugins");
  const { loadKindRegistry } = await import("./kinds");
  const located = findWorkspaceRoot(cwd);
  const doc = listWorkspace({ cwd });
  if (!located || "error" in doc) return [];
  const out = new Set<string>();
  const kinds = doc.members.some((m) => m.kind !== "chant" && m.readable) ? loadKindRegistry(doc.workspace.pins, located.dir).registry : undefined;
  for (const m of doc.members) {
    if (!m.readable) continue;
    const reader = m.kind === "chant" ? undefined : kinds?.get(m.kind)?.graph?.lexicon;
    if (reader) out.add(reader);
    if (m.kind !== "chant") continue;
    try {
      for (const l of await resolveProjectLexicons(resolve(located.dir, m.dir))) out.add(l);
    } catch {
      // A member whose lexicons can't be resolved adds none; its own search says why.
    }
  }
  return [...out];
}

/** The catalog as text: one capability per line, its search term and meaning, then its parameters. */
export function formatCapabilities(doc: CapabilitiesResult): string[] {
  const width = Math.max(...doc.capabilities.map((c) => c.search.length));
  const lines: string[] = [];
  for (const c of doc.capabilities) {
    lines.push(`${c.search.padEnd(width)}  ${c.shape.padEnd(4)}  ${c.meaning}`);
    for (const p of c.params) lines.push(`${"".padEnd(width)}        ${p.name}${p.optional ? "?" : ""}: ${p.meaning}`);
    const unsupported = Object.entries(c.lexicons).filter(([, s]) => s !== "supported");
    for (const [lex, s] of unsupported) lines.push(`${"".padEnd(width)}        not in ${lex}: ${(s as { message: string }).message}`);
  }
  const lexicons = Object.keys(doc.capabilities[0]?.lexicons ?? {});
  lines.push(`— ${doc.capabilities.length} capabilities${lexicons.length ? ` · lexicons ${lexicons.join(", ")}` : ""} · --json prints each rule`);
  return lines;
}
