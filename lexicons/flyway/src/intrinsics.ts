/**
 * Flyway intrinsic functions.
 *
 * Flyway TOML supports resolver references like `${vault.password}`
 * and built-in placeholder references like `${flyway:defaultSchema}`.
 */

import { INTRINSIC_MARKER, type Intrinsic } from "@intentius/chant/intrinsic";

/**
 * Resolver reference intrinsic.
 * Serializes to `${resolverName.key}` in TOML output.
 */
export class ResolverRefIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;

  constructor(
    private readonly resolverName: string,
    private readonly key: string,
  ) {}

  toJSON(): string {
    return `\${${this.resolverName}.${this.key}}`;
  }
}

/**
 * Built-in placeholder reference intrinsic.
 * Serializes to `${flyway:name}` in TOML output.
 */
export class PlaceholderRefIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;

  constructor(private readonly name: string) {}

  toJSON(): string {
    return `\${flyway:${this.name}}`;
  }
}

/**
 * Environment variable reference intrinsic.
 * Serializes to `${env.VAR_NAME}` in TOML output.
 */
export class EnvRefIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;

  constructor(private readonly varName: string) {}

  toJSON(): string {
    return `\${env.${this.varName}}`;
  }
}

/**
 * Create a resolver reference.
 * @example resolve("vault", "password") → "${vault.password}"
 */
export function resolve(resolverName: string, key: string): ResolverRefIntrinsic {
  return new ResolverRefIntrinsic(resolverName, key);
}

/**
 * Create a built-in placeholder reference.
 * @example placeholder("defaultSchema") → "${flyway:defaultSchema}"
 */
export function placeholder(name: string): PlaceholderRefIntrinsic {
  return new PlaceholderRefIntrinsic(name);
}

/**
 * Create an environment variable reference.
 * @example env("DB_PASSWORD") → "${env.DB_PASSWORD}"
 */
export function env(varName: string): EnvRefIntrinsic {
  return new EnvRefIntrinsic(varName);
}
