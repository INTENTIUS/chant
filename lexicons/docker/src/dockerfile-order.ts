/**
 * The order a Dockerfile stage's per-kind fields (`run`, `copy`, `user`, ...)
 * are written in when the stage has no `steps`. It never changes, so a
 * Dockerfile declared with per-kind fields builds the same output it always
 * has; `steps` is how a stage controls its own order.
 */
export const PER_KIND_ORDER = [
  "arg", "env", "workdir", "user", "run", "copy", "add",
  "expose", "volume", "label", "entrypoint", "cmd", "healthcheck",
] as const;

export type PerKindField = (typeof PER_KIND_ORDER)[number];

/** The step keys whose array value is written in JSON exec form. */
export const EXEC_FORM_STEPS: ReadonlySet<string> = new Set(["run", "cmd", "entrypoint", "shell"]);

/** Every instruction a step can name. FROM is the stage's own field. */
export const STEP_INSTRUCTIONS: ReadonlySet<string> = new Set([
  ...PER_KIND_ORDER, "shell", "stopsignal", "onbuild",
]);
