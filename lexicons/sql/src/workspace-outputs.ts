/**
 * The sql lexicon's workspace outputs now live in ./declared-outputs.ts, so
 * the plugin can feed the level-0 `chant graph` without importing a module
 * whose name marks it as workspace code (#5229). This path stays for the
 * imports that name it.
 */

export * from "./declared-outputs";
