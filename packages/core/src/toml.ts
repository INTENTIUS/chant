/**
 * TOML emitter and parser — re-exports from split modules.
 *
 * Import from here for the public API:
 *   import { emitTOML, parseTOML } from "@intentius/chant/toml";
 */

export { emitTOML, type EmitTOMLOptions } from "./toml-emit";
export { parseTOML } from "./toml-parse";
