/**
 * The TypeScript compiler API chant parses with, for lexicon lint rules and
 * language services (#3864).
 *
 * Core parses every source file with its own `typescript` dependency, which
 * stays on 5.x. A lexicon that imported `typescript` itself got the project's
 * copy instead, and a project on TypeScript 7 has no JS compiler API there:
 * `ts.isImportDeclaration` is undefined and every rule threw. Even when two
 * 5.x copies load, their `SyntaxKind` numbers can differ between minors, so a
 * rule must test nodes with the same module that built them.
 *
 * Lexicons import `ts` from here, never from "typescript":
 *
 *     import { ts } from "@intentius/chant/lint/typescript";
 */
import * as ts from "typescript";

export { ts };
