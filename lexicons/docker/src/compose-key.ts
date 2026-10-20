/**
 * The key an entity takes in docker-compose.yml.
 *
 * A compose entity's key is its export name by default. A key that is not a
 * TypeScript identifier (`db-password`, `nginx.conf`) cannot be an export
 * name, so `composeKey` sets it explicitly (#3937):
 *
 * @example
 * export const dbPassword = composeKey("db-password", new DockerSecret({ file: "./db-password.txt" }));
 *
 * References to the entity (`secrets: [dbPassword]`) serialize as the key.
 */

import type { Declarable } from "@intentius/chant/declarable";

export const COMPOSE_KEY = Symbol.for("docker.composeKey");

/** Give a compose entity an explicit key in docker-compose.yml. Returns the entity. */
export function composeKey<T extends Declarable>(key: string, entity: T): T {
  if (typeof key !== "string" || key === "") {
    throw new Error("composeKey: the key must be a non-empty string");
  }
  Object.defineProperty(entity, COMPOSE_KEY, { value: key, enumerable: false, configurable: true });
  return entity;
}

/** The key set by `composeKey`, or undefined. */
export function getComposeKey(entity: Declarable): string | undefined {
  const key = (entity as unknown as Record<symbol, unknown>)[COMPOSE_KEY];
  return typeof key === "string" ? key : undefined;
}
