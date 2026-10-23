/**
 * The terraform lexicon's capability pack (#4375): its mapping onto the
 * lexicon-neutral view, as data, and the one thing the mapping can't say as
 * data, how to read a policy written as `jsonencode({...})`.
 */
import type { CapabilityAdapter, CapabilityMapping, CapabilityPack } from "@intentius/chant/capabilities/view";
import mapping from "./mapping.json" with { type: "json" };
import { isUnknown, readJsonencode } from "../hcl/jsonencode";

/** Turn each value position `readJsonencode` couldn't read into its expression, as `${...}` text. */
function withExpressions(v: unknown): unknown {
  if (isUnknown(v)) return v.source !== undefined ? `\${${v.source}}` : undefined;
  if (Array.isArray(v)) return v.map(withExpressions);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, withExpressions(x)]));
  }
  return v;
}

export const terraformCapabilityAdapter: CapabilityAdapter = {
  readDocument(value: unknown): unknown {
    // An inline_policy block carries the document in its `policy` argument.
    const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).policy : value;
    const read = readJsonencode(raw, { unknownLeaves: true });
    return read.kind === "literal" ? withExpressions(read.value) : undefined;
  },
};

export const terraformCapabilityPack: CapabilityPack = {
  mapping: mapping as CapabilityMapping,
  adapter: terraformCapabilityAdapter,
};
