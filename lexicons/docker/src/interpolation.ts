/**
 * Docker Compose variable interpolation intrinsics.
 *
 * Docker Compose supports:
 *   ${VAR}              — required variable (fails if unset)
 *   ${VAR:-default}     — use default if VAR is unset or empty
 *   ${VAR:?error}       — fail with error message if VAR is unset or empty
 *   ${VAR:+value}       — use value if VAR is set
 *
 * @example
 * import { env } from "@intentius/chant-lexicon-docker";
 *
 * export const api = new Service({
 *   image: env("APP_IMAGE", { default: "myapp:latest" }),
 *   environment: {
 *     DB_URL: env("DB_URL", { required: true }),
 *   },
 * });
 *
 * // Serializes to:
 * // services:
 * //   api:
 * //     image: ${APP_IMAGE:-myapp:latest}
 * //     environment:
 * //       DB_URL: ${DB_URL:?DB_URL is required}
 */

import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";

export interface EnvOptions {
  /** Default value if VAR is unset or empty: ${VAR:-default} */
  default?: string;
  /** If true and no default, emit ${VAR:?VAR is required}: fail on missing */
  required?: boolean;
  /** Error message for required variables: ${VAR:?errorMessage} */
  errorMessage?: string;
  /** Alternate value when VAR is set: ${VAR:+value} */
  ifSet?: string;
}

export interface EnvIntrinsic {
  readonly [INTRINSIC_MARKER]: true;
  /** Emit the Docker Compose interpolation string */
  toJSON(): string;
  toString(): string;
}

/**
 * Create a Docker Compose variable interpolation intrinsic.
 *
 * @param name - Environment variable name
 * @param opts - Interpolation options
 */
export function env(name: string, opts: EnvOptions = {}): EnvIntrinsic {
  function interpolationString(): string {
    if (opts.ifSet !== undefined) {
      return `\${${name}:+${opts.ifSet}}`;
    }
    if (opts.default !== undefined) {
      return `\${${name}:-${opts.default}}`;
    }
    if (opts.required || opts.errorMessage) {
      const msg = opts.errorMessage ?? `${name} is required`;
      return `\${${name}:?${msg}}`;
    }
    return `\${${name}}`;
  }

  const value = interpolationString();

  return {
    [INTRINSIC_MARKER]: true,
    toJSON: () => value,
    toString: () => value,
  };
}
