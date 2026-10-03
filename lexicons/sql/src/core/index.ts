/**
 * The sql lexicon's shared core: what every dialect (`../clickhouse/`, and
 * Postgres next, #3289) builds on, with no database's grammar in it (#3275
 * question 7, #3047 question 1).
 *
 * Belongs here:
 *
 * - the entity base and Declarable plumbing, and column references
 *   (`entity.ts`);
 * - the lossless tokenizer, with each dialect's character-level rules as a
 *   table (`tokens.ts`), and the parser base: a cursor over significant
 *   tokens with expressions kept as token spans (`cursor.ts`);
 * - the tagged-template plumbing: raw parts, what a plain interpolation
 *   splices in, `SqlLiteral`, the tag's error (`template.ts`), and splicing,
 *   span text, what each spliced value fed, and a view's column lineage
 *   (`interpolation.ts`);
 * - finding a dialect's templates in a source file by the module its tags
 *   are imported from, for lint and the editor (`find-templates.ts`);
 * - references between objects, column lineage, and the creation order
 *   (`references.ts`);
 * - identity and renames between two schemas, and the change-set model
 *   (`diff.ts`);
 * - the classifier framework: the rule shape, classes as data per dialect,
 *   `classifyDisruption()` over a dialect's rules, the text report
 *   (`classifier.ts`);
 * - normalization helpers that are not a database's grammar, such as the
 *   `-- previously:` hint (`normalize.ts`);
 * - the ownership trailer on an object's comment (`ownership.ts`);
 * - receipts kept on the server (`receipts.ts`);
 * - the applier's tri-state outcome, its envelope projection and the build
 *   output reader (`apply.ts`);
 * - the hand-off from a refused change to a migration Op (`handoff.ts`);
 * - a throwaway server in a container, and test helpers that are not one
 *   database's (`container.ts`, `testing/`).
 *
 * Stays in a dialect: its lexical rules and statement grammar, its key words
 * and identifier quoting, `literal()`'s escaping, its entity types and props,
 * its generated types and overlays, its normalization rules, its rule ids
 * and classes and the documentation they cite, the statements its applier
 * sends and how it waits on the server, its client and binding, import and
 * observation over its catalog, and its migration Op.
 *
 * Nothing here is exported from the package root or a dialect subpath on its
 * own: each dialect re-exports what its public surface names.
 */

export * from "./entity";
export * from "./tokens";
export * from "./cursor";
export * from "./template";
export * from "./interpolation";
export * from "./find-templates";
export * from "./references";
export * from "./diff";
export * from "./classifier";
export * from "./normalize";
export * from "./ownership";
export * from "./receipts";
export * from "./apply";
export * from "./handoff";
export * from "./container";
