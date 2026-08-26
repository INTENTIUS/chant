/**
 * Parsed-output view for post-synth checks (chant #975).
 *
 * `PostSynthContext.outputs` carries raw serialized strings — a `chant build`
 * consumer has to parse YAML/JSON itself before it can reason about
 * structure. Every lexicon that needs this today rolls its own splitter
 * (`parseK8sManifests` in k8s, hand-rolled `JSON.parse` in aws's
 * `cf-refs.ts`), and each of the ~30 k8s post-synth checks reparses the same
 * output independently. This module is the shared, parse-once primitive:
 * `parseOutputDocs` turns `ctx.outputs` into a flat list of `OutputDoc`s,
 * and `PostSynthContext.docs` (see `./post-synth.ts`) memoizes one call to it
 * per build so every check — lexicon-shipped or project-authored policy —
 * shares the same parse.
 *
 * `pick`/`get` are the "look at only the fields you care about" ergonomic
 * from the issue's `,remain`-style framing — a partial, unvalidated view of
 * an already-parsed tree, not a query DSL. Selector languages over the
 * *source* AST stay in `./declarative.ts`; this module is output-side only.
 */

import type { SerializerResult } from "../serializer";
import { parseYAML } from "../yaml";

/**
 * One parsed document from a build's serialized output.
 *
 * A single `ctx.outputs` entry can yield more than one `OutputDoc`: a
 * multi-document YAML stream (`---`-separated) yields one per document, and
 * a `SerializerResult` with `files` yields further docs for each nested
 * file (a CloudFormation nested stack template, a sidecar manifest).
 */
export interface OutputDoc {
  /** The `ctx.outputs` map key this document came from. */
  lexicon: string;
  /** Position of this document within its source (primary output or one
   *  `files` entry) — 0 for a single-document source, 0..n-1 for a
   *  multi-document YAML stream. */
  index: number;
  /** Whether this document was decoded as YAML or as whole-content JSON. */
  format: "yaml" | "json";
  /** The parsed tree. `undefined` when parsing failed — see `error`. */
  value: unknown;
  /**
   * Set when this document came from a `SerializerResult.files` entry rather
   * than the primary output — the file's key in that map (e.g. a nested
   * stack template's filename).
   */
  file?: string;
  /**
   * Set when this document could not be parsed into a usable tree. The
   * document is still returned (a marker, not a throw) so a caller can see
   * that something in the build output failed to parse, rather than the
   * failure disappearing silently the way `parseK8sManifests` has always
   * swallowed it. `value` is `undefined` on an errored document. Filter with
   * `ctx.docs.filter((d) => !d.error)` to get only usable documents.
   */
  error?: string;
}

/**
 * Parse every output in `outputs` into a flat list of `OutputDoc`s: one call,
 * shared by every post-synth check via `PostSynthContext.docs`.
 *
 * Format detection is whole-source, not per-document: if the entire source
 * parses as JSON, it is one `"json"` document (CloudFormation, most non-k8s
 * serializers). Otherwise the source is treated as a YAML stream — split on
 * `---` document separators — and each resulting document is parsed as YAML
 * (`format: "yaml"`), even one that happens to also be valid JSON, since
 * JSON is a YAML subset. `SerializerResult.files` entries (nested templates,
 * sidecar manifests) are parsed the same way, tagged with `file`.
 *
 * A document that fails to parse into a non-null object/array — malformed
 * input, or a bare scalar where a manifest was expected — is not thrown:
 * it is included with `error` set and `value: undefined`. See `OutputDoc`.
 */
export function parseOutputDocs(outputs: Map<string, string | SerializerResult>): OutputDoc[] {
  const docs: OutputDoc[] = [];
  for (const [lexicon, output] of outputs) {
    const primary = typeof output === "string" ? output : output.primary;
    docs.push(...parseSource(primary, lexicon));

    const files = typeof output === "string" ? undefined : output.files;
    for (const [file, content] of Object.entries(files ?? {})) {
      docs.push(...parseSource(content, lexicon, file));
    }
  }
  return docs;
}

/** Split a YAML stream on `---` document-separator lines (own line, optional
 *  trailing whitespace) — including a leading separator before any content,
 *  which `"\n---\n"`-style splitting misses. Empty documents (two separators
 *  back to back, or a leading/trailing one) are dropped. */
function splitYamlDocuments(source: string): string[] {
  return source
    .split(/^---[ \t]*$/m)
    .map((doc) => doc.trim())
    .filter((doc) => doc.length > 0);
}

/** True for a value a document is usable as — a non-null object or array.
 *  A bare scalar ("just a string") parses without error but is not a
 *  document a check can walk, so it is treated as malformed. */
function isUsableDoc(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/**
 * Parse one source string (a primary output, or one `files` entry) into its
 * `OutputDoc`s, trying whole-content JSON first and falling back to a
 * (possibly multi-document) YAML stream. Never throws — a parse failure or
 * an unusable result becomes a marker document with `error` set.
 */
function parseSource(source: string, lexicon: string, file?: string): OutputDoc[] {
  const trimmed = source.trim();
  if (trimmed === "") return [];

  try {
    const value = JSON.parse(trimmed);
    if (isUsableDoc(value)) {
      return [{ lexicon, index: 0, format: "json", value, ...(file && { file }) }];
    }
    return [
      {
        lexicon,
        index: 0,
        format: "json",
        value: undefined,
        error: "parsed JSON is not an object or array",
        ...(file && { file }),
      },
    ];
  } catch {
    // Not whole-content JSON — fall through to the YAML stream path.
  }

  return splitYamlDocuments(trimmed).map((segment, index) => {
    try {
      const value = parseYAML(segment);
      if (isUsableDoc(value)) {
        return { lexicon, index, format: "yaml" as const, value, ...(file && { file }) };
      }
      return {
        lexicon,
        index,
        format: "yaml" as const,
        value: undefined,
        error: "parsed YAML document is not an object or array",
        ...(file && { file }),
      };
    } catch (err) {
      return {
        lexicon,
        index,
        format: "yaml" as const,
        value: undefined,
        error: err instanceof Error ? err.message : String(err),
        ...(file && { file }),
      };
    }
  });
}

/**
 * Partial typed decode — the `,remain`-style ergonomic from `ma91n/tfpolicy`:
 * decode the fields you care about, leave everything else in place,
 * unvalidated. Returns a shallow, top-level view of `value` narrowed to the
 * keys named in `shape`. A key absent from `value` (or `value` not being a
 * plain object) is simply absent from the result — no default is invented.
 *
 * This is NOT runtime validation: a key that IS present is copied as-is,
 * whatever its actual shape, and cast to `T`'s declared type for that key.
 * Use `get` for a deeper walk into one of the picked values.
 */
export function pick<T extends object>(value: unknown, shape: (keyof T)[]): Partial<T> {
  const result: Partial<T> = {};
  if (typeof value !== "object" || value === null) return result;
  const source = value as Record<string, unknown>;
  for (const key of shape) {
    const propertyName = key as string;
    if (propertyName in source) {
      (result as Record<string, unknown>)[propertyName] = source[propertyName];
    }
  }
  return result;
}

/**
 * Dotted-path getter for the common walk over a parsed doc, e.g.
 * `get(doc.value, "spec.template.spec")`. Not a query DSL — no wildcards,
 * no predicates, no array-flattening. An array index is just a numeric path
 * segment (`get(value, "items.0.name")`), since JS indexes arrays by string
 * key underneath. Returns `undefined` as soon as any segment is missing or
 * the value at that point isn't indexable — it never throws on a bad path.
 */
export function get(value: unknown, path: string): unknown {
  if (path === "") return value;
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
