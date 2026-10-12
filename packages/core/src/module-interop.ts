/**
 * The namespace a project module was authored with, whichever module format
 * tsx compiled it to (#3897).
 *
 * A `.ts` file with no `"type": "module"` `package.json` above it is compiled
 * by tsx as CommonJS: `exports.default = ...` plus a non-enumerable
 * `__esModule: true` marker. The compiled CLI loads project files with a
 * native `import()`, and Node hands a CommonJS module back as a namespace
 * whose `default` is the whole `module.exports`. So `export default x` arrives
 * as `namespace.default.default`. Under the source CLI tsx's ESM loader sits
 * in front of the `import()` and does this interop itself, which is why the
 * nesting only showed up once the CLI ran compiled (#3879).
 *
 * When `namespace.default` carries the `__esModule` marker, the module's real
 * namespace is that exports object: this returns a copy of it with the marker
 * left out. Anything else, including an ES module whose default export is an
 * object that happens to have a `default` key, is returned unchanged.
 */
export function esModuleNamespace<T extends Record<string, unknown>>(namespace: T): T {
  // `in` before the read: a vitest factory mock throws on reading an export
  // it does not define, and most modules have no `default` at all.
  if (namespace === null || typeof namespace !== "object" || !("default" in namespace)) return namespace;
  const exported = namespace.default;
  if (!isCommonJsEsModule(exported)) return namespace;
  const unwrapped: Record<string, unknown> = {};
  for (const key of Object.keys(exported)) {
    if (key !== "__esModule") unwrapped[key] = exported[key];
  }
  return unwrapped as T;
}

/** A CommonJS `module.exports` that a compiler marked as an ES module. */
function isCommonJsEsModule(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    (value as { __esModule?: unknown }).__esModule === true
  );
}
