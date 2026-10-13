/**
 * Workspace reader conformance (#2657, ws-052). The suite ships in
 * `@intentius/chant` since #2679, as `@intentius/chant/workspace/conformance`
 * (runner-neutral) and `@intentius/chant/workspace/conformance/vitest`, so a
 * reader outside this repository can install and run it. This file re-exports
 * it for chant's own tests.
 */

export * from "../../core/src/workspace/conformance/vitest";
