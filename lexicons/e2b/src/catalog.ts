/**
 * The one kind the e2b lexicon declares, described once.
 *
 * The LSP's completions and hover, the bundle's `dist/meta.json` and the docs'
 * resource reference all read this table, so a property added to `Template`
 * is added here and reaches all three.
 */

import type { LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";

export const TEMPLATE_TYPE = "E2B::Template";

export interface PropertyDoc {
  type: string;
  required?: boolean;
  description: string;
}

/** `Template`'s properties, in the order the hover lists them. */
export const TEMPLATE_PROPERTIES: Record<string, PropertyDoc> = {
  name: {
    type: "string",
    required: true,
    description:
      "The template's name on E2B: lowercase letters, digits, dashes and underscores. A profile's `template` names it.",
  },
  fromImage: {
    type: "string",
    required: true,
    description: "The Debian-based image the template starts from, such as `node:22-bookworm`. Pin a tag.",
  },
  run: {
    type: "string[]",
    description: "Shell commands run in order while the template builds, one `RUN` line each.",
  },
  env: {
    type: "Record<string, string>",
    description: "Environment variables set in every sandbox made from the template.",
  },
  workdir: {
    type: "string",
    description: "The working directory for the `run` steps and the start command.",
  },
  startCmd: {
    type: "string",
    description: "A command E2B runs when the template is snapshotted, so a sandbox starts with it running.",
  },
  readyCmd: {
    type: "string",
    description: "A command E2B polls until it exits 0 before it snapshots the template.",
  },
  cpuCount: {
    type: "number",
    description: "vCPUs per sandbox. A positive integer; E2B's default is 2.",
  },
  memoryMB: {
    type: "number",
    description: "Memory per sandbox in MiB. A positive even integer; E2B's default is 512.",
  },
  teamId: {
    type: "string",
    description: "The E2B team that owns the template, when the API key can act for more than one.",
  },
};

/** The registry the LSP and `dist/meta.json` read: one resource entry. */
export const LEXICON_ENTRIES: Record<string, LexiconEntry> = {
  Template: {
    resourceType: TEMPLATE_TYPE,
    kind: "resource",
    lexicon: "e2b",
    propertyConstraints: Object.fromEntries(
      Object.entries(TEMPLATE_PROPERTIES).map(([name, p]) => [name, { type: p.type, required: p.required ?? false }]),
    ),
  },
};
