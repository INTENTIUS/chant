/**
 * `import.meta.main` — Bun and Deno set it; the TypeScript DOM/ES lib does not
 * declare it (#1366).
 *
 * The repo's roundtrip helper scripts use the `if (import.meta.main)` guard so a
 * module can be both imported and run directly, which is the idiomatic form
 * under the runtime they are written for. Declaring it here rather than casting
 * at each call site keeps the guard readable and makes the assumption explicit
 * in one place.
 */
interface ImportMeta {
  /** True when this module is the program's entry point (Bun/Deno). */
  readonly main?: boolean;
}
