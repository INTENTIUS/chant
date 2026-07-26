/**
 * Error types for chant discovery, build, and lint failures
 */

/**
 * `"permission"` (chant #1045 Phase 2) — a run-fallback file executing inside
 * the sandboxed child (`./discovery/sandbox/`) hit Node's Permission Model
 * (`ERR_ACCESS_DENIED`) — filesystem, child-process, or worker-thread access
 * outside the sandbox's allowlist. Distinct from `"import"` (a module simply
 * failed to load/execute for an ordinary reason) so a permission denial is
 * recognizable as a sandbox boundary hit, not a generic import failure.
 */
export type DiscoveryErrorType = "import" | "resolution" | "circular" | "permission";

/**
 * Error during file discovery or module import
 */
export class DiscoveryError extends Error {
  readonly file: string;
  readonly type: DiscoveryErrorType;

  constructor(file: string, message: string, type: DiscoveryErrorType) {
    super(message);
    this.name = "DiscoveryError";
    this.file = file;
    this.type = type;
  }

  toJSON() {
    return {
      name: this.name,
      file: this.file,
      message: this.message,
      type: this.type,
    };
  }
}

/**
 * Error during build/serialization
 */
export class BuildError extends Error {
  readonly entityName: string;

  constructor(entityName: string, message: string) {
    super(message);
    this.name = "BuildError";
    this.entityName = entityName;
  }

  toJSON() {
    return {
      name: this.name,
      entityName: this.entityName,
      message: this.message,
    };
  }
}

/**
 * Error from lint rule violation
 */
export class LintError extends Error {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly ruleId: string;

  constructor(
    file: string,
    line: number,
    column: number,
    ruleId: string,
    message: string
  ) {
    super(message);
    this.name = "LintError";
    this.file = file;
    this.line = line;
    this.column = column;
    this.ruleId = ruleId;
  }

  toJSON() {
    return {
      name: this.name,
      file: this.file,
      line: this.line,
      column: this.column,
      ruleId: this.ruleId,
      message: this.message,
    };
  }
}
