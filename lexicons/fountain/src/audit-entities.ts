/**
 * Parse-to-graph for `chant audit` (#1567).
 *
 * Audit discovery classifies standalone fountain manifests (#1566); this
 * module turns one classified file's content back into the entity graph the
 * FTN post-synth checks read (`ctx.entities`), so the same graph-reading
 * rules that fire on `chant build` fire on an audit of hand-written
 * `fountain apply` YAML — one implementation per rule, no output-reading
 * variants to drift.
 *
 * Tolerant by contract: the audit runs against any repo, so a malformed
 * document contributes no entities instead of throwing, and documents are
 * parsed one at a time so one bad document doesn't take down the file's
 * others. A name declared twice keeps both declarations in the map (the
 * second gets a `#n`-suffixed key), so nothing is silently dropped and
 * FTN017's duplicate-name detection still sees the collision.
 */

import type { Declarable } from "@intentius/chant";
import { FountainParser } from "./import/parser";

/** Parse standalone fountain YAML (or a fountain-plan.json) into `ctx.entities`. */
export function fountainAuditEntities(content: string): Map<string, Declarable> {
  const entities = new Map<string, Declarable>();
  const parser = new FountainParser();
  for (const docText of content.split(/^---\s*$/m)) {
    if (!docText.trim()) continue;
    let resources;
    try {
      resources = parser.parse(docText).resources;
    } catch {
      continue; // malformed document — no entities, never a crash
    }
    for (const r of resources) {
      let key = r.logicalId;
      for (let n = 2; entities.has(key); n++) key = `${r.logicalId}#${n}`;
      // The plain-object entity shape the checks' `propsOf` reads: authored
      // props under `.props`, mirroring real createResource instances.
      entities.set(key, { lexicon: "fountain", entityType: r.type, props: r.properties } as unknown as Declarable);
    }
  }
  return entities;
}
