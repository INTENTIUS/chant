/**
 * GitHub Actions expression system.
 *
 * Provides a typed Expression class and context accessors for building
 * ${{ }} expressions in GitHub Actions workflows.
 */

import { INTRINSIC_MARKER, type Intrinsic } from "@intentius/chant/intrinsic";

/**
 * A GitHub Actions expression that serializes to `${{ raw }}`.
 */
export class Expression implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private readonly _raw: string;

  constructor(raw: string) {
    this._raw = raw;
  }

  /** The raw expression string without ${{ }} wrapper. */
  raw(): string {
    return this._raw;
  }

  /** Returns the expression wrapped in ${{ }}. */
  toString(): string {
    return `\${{ ${this._raw} }}`;
  }

  toJSON(): string {
    return this.toString();
  }

  /** YAML serialization — plain string with ${{ }}. */
  toYAML(): string {
    return this.toString();
  }

  /** Logical AND with another expression. */
  and(other: Expression): Expression {
    return new Expression(`${this._raw} && ${other._raw}`);
  }

  /** Logical OR with another expression. */
  or(other: Expression): Expression {
    return new Expression(`${this._raw} || ${other._raw}`);
  }

  /** Logical NOT of this expression. */
  not(): Expression {
    return new Expression(`!(${this._raw})`);
  }

  /** Equality comparison. */
  eq(value: string | Expression): Expression {
    const rhs = value instanceof Expression ? value._raw : `'${value}'`;
    return new Expression(`${this._raw} == ${rhs}`);
  }

  /** Inequality comparison. */
  ne(value: string | Expression): Expression {
    const rhs = value instanceof Expression ? value._raw : `'${value}'`;
    return new Expression(`${this._raw} != ${rhs}`);
  }
}

// ── Context accessors ─────────────────────────────────────────────

/** GitHub context — github.* properties. */
export const github = {
  get ref() { return new Expression("github.ref"); },
  get sha() { return new Expression("github.sha"); },
  get actor() { return new Expression("github.actor"); },
  get repository() { return new Expression("github.repository"); },
  get repositoryOwner() { return new Expression("github.repository_owner"); },
  get event() { return new Expression("github.event"); },
  get eventName() { return new Expression("github.event_name"); },
  get runId() { return new Expression("github.run_id"); },
  get runNumber() { return new Expression("github.run_number"); },
  get workflow() { return new Expression("github.workflow"); },
  get workspace() { return new Expression("github.workspace"); },
  get token() { return new Expression("github.token"); },
  get job() { return new Expression("github.job"); },
  get refName() { return new Expression("github.ref_name"); },
  get refType() { return new Expression("github.ref_type"); },
  get headRef() { return new Expression("github.head_ref"); },
  get baseRef() { return new Expression("github.base_ref"); },
  get serverUrl() { return new Expression("github.server_url"); },
  get apiUrl() { return new Expression("github.api_url"); },
  get graphqlUrl() { return new Expression("github.graphql_url"); },
  get action() { return new Expression("github.action"); },
  get actionPath() { return new Expression("github.action_path"); },
  get triggeringActor() { return new Expression("github.triggering_actor"); },
} as const;

/** Runner context — runner.* properties. */
export const runner = {
  get os() { return new Expression("runner.os"); },
  get arch() { return new Expression("runner.arch"); },
  get temp() { return new Expression("runner.temp"); },
  get toolCache() { return new Expression("runner.tool_cache"); },
  get name() { return new Expression("runner.name"); },
} as const;

/** Access a secret by name. */
export function secrets(name: string): Expression {
  return new Expression(`secrets.${name}`);
}

/** Access a matrix value by key. */
export function matrix(key: string): Expression {
  return new Expression(`matrix.${key}`);
}

/** Access a step output. */
export function steps(id: string): { outputs(name: string): Expression } {
  return {
    outputs(name: string): Expression {
      return new Expression(`steps.${id}.outputs.${name}`);
    },
  };
}

/** Access a job output from a needed job. */
export function needs(job: string): { outputs(name: string): Expression } {
  return {
    outputs(name: string): Expression {
      return new Expression(`needs.${job}.outputs.${name}`);
    },
  };
}

/** Access a workflow input. */
export function inputs(name: string): Expression {
  return new Expression(`inputs.${name}`);
}

/** Access a configuration variable. */
export function vars(name: string): Expression {
  return new Expression(`vars.${name}`);
}

/** Access an environment variable. */
export function env(name: string): Expression {
  return new Expression(`env.${name}`);
}

// ── Condition helpers ─────────────────────────────────────────────

/** Always run, regardless of status. */
export function always(): Expression {
  return new Expression("always()");
}

/** Run only if a previous step has failed. */
export function failure(): Expression {
  return new Expression("failure()");
}

/** Run only if all previous steps succeeded (default). */
export function success(): Expression {
  return new Expression("success()");
}

/** Run only if the workflow was cancelled. */
export function cancelled(): Expression {
  return new Expression("cancelled()");
}

// ── Function helpers ──────────────────────────────────────────────

/** Check if a string contains a substring. */
export function contains(haystack: Expression | string, needle: Expression | string): Expression {
  const h = haystack instanceof Expression ? haystack.raw() : `'${haystack}'`;
  const n = needle instanceof Expression ? needle.raw() : `'${needle}'`;
  return new Expression(`contains(${h}, ${n})`);
}

/** Check if a string starts with a prefix. */
export function startsWith(value: Expression | string, prefix: Expression | string): Expression {
  const v = value instanceof Expression ? value.raw() : `'${value}'`;
  const p = prefix instanceof Expression ? prefix.raw() : `'${prefix}'`;
  return new Expression(`startsWith(${v}, ${p})`);
}

/** Convert a value to JSON. */
export function toJSON(value: Expression): Expression {
  return new Expression(`toJSON(${value.raw()})`);
}

/** Parse a JSON string. */
export function fromJSON(json: Expression | string): Expression {
  const j = json instanceof Expression ? json.raw() : `'${json}'`;
  return new Expression(`fromJSON(${j})`);
}

/** Format a string with placeholders. */
export function format(template: string, ...args: Expression[]): Expression {
  const argStrs = args.map((a) => a.raw()).join(", ");
  return new Expression(`format('${template}', ${argStrs})`);
}

// ── Convenience helpers ───────────────────────────────────────────

/** Check if the ref matches a branch name. */
export function branch(name: string): Expression {
  return github.ref.eq(`refs/heads/${name}`);
}

/** Check if the ref matches a tag prefix. */
export function tag(name: string): Expression {
  return startsWith(github.ref, `refs/tags/${name}`);
}
