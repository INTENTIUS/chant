import { isDeclarable, type Declarable } from "./declarable";

/**
 * Marker symbol for Composite type identification.
 */
export const COMPOSITE_MARKER = Symbol.for("chant.composite");

/**
 * A record of named Declarable members produced by a composite factory.
 */
export type CompositeMembers = Record<string, Declarable>;

/**
 * The result of instantiating a composite — contains the marker and expanded members.
 */
export interface CompositeInstance<M extends CompositeMembers = CompositeMembers> {
  readonly [COMPOSITE_MARKER]: true;
  readonly members: M;
  readonly _definition: CompositeDefinition<any, M>;
}

/**
 * A composite definition: a callable that produces a CompositeInstance.
 */
export interface CompositeDefinition<P, M extends CompositeMembers = CompositeMembers> {
  (props: P): CompositeInstance<M> & M;
  readonly compositeName: string;
  readonly _id: symbol;
}

/**
 * Type guard: is this value a CompositeInstance?
 */
export function isCompositeInstance(value: unknown): value is CompositeInstance {
  return (
    typeof value === "object" &&
    value !== null &&
    COMPOSITE_MARKER in value &&
    (value as Record<symbol, unknown>)[COMPOSITE_MARKER] === true
  );
}

/**
 * Global registry of composite definitions.
 */
export class CompositeRegistry {
  private static definitions = new Map<symbol, CompositeDefinition<unknown>>();

  static register(definition: CompositeDefinition<unknown>): void {
    this.definitions.set(definition._id, definition);
  }

  static getAll(): CompositeDefinition<unknown>[] {
    return Array.from(this.definitions.values());
  }

  static clear(): void {
    this.definitions.clear();
  }

  static get size(): number {
    return this.definitions.size;
  }
}

/**
 * Creates a composite definition from a factory closure.
 *
 * Usage:
 * ```ts
 * const SecureStorage = Composite<{ name: string }>((props) => {
 *   const bucket = new Bucket({ bucketName: props.name });
 *   const role = new Role({ policies: [{ resource: bucket.arn }] });
 *   return { bucket, role };
 * });
 * export const storage = SecureStorage({ name: "data" });
 * ```
 */
export function Composite<P, M extends CompositeMembers = CompositeMembers>(
  factory: (props: P) => M,
  name?: string,
): CompositeDefinition<P, M> {
  const id = Symbol();
  const compositeName = name ?? "anonymous";

  const definition = ((props: P): CompositeInstance<M> & M => {
    const members = factory(props);

    for (const [key, value] of Object.entries(members)) {
      if (!isDeclarable(value) && !isCompositeInstance(value)) {
        throw new Error(
          `Composite "${compositeName}" member "${key}" is not a Declarable or CompositeInstance`,
        );
      }
    }

    const instance: CompositeInstance<M> = {
      [COMPOSITE_MARKER]: true,
      members,
      _definition: definition,
    };

    return Object.assign(instance, members) as CompositeInstance<M> & M;
  }) as CompositeDefinition<P, M>;

  Object.defineProperty(definition, "compositeName", { value: compositeName, writable: false });
  Object.defineProperty(definition, "_id", { value: id, writable: false });

  CompositeRegistry.register(definition as CompositeDefinition<unknown>);

  return definition;
}

/**
 * Expands a CompositeInstance into a flat Map of prefixed entity names to Declarables.
 * Handles nested composites recursively.
 */
export function expandComposite(
  prefix: string,
  instance: CompositeInstance,
): Map<string, Declarable> {
  const result = new Map<string, Declarable>();
  const shared = (instance as any)[SHARED_PROPS] as Record<string, unknown> | undefined;

  for (const [memberName, member] of Object.entries(instance.members)) {
    const fullName = `${prefix}_${memberName}`;

    if (isCompositeInstance(member)) {
      const nested = expandComposite(fullName, member);
      for (const [nestedName, nestedEntity] of nested) {
        result.set(nestedName, nestedEntity);
      }
    } else {
      result.set(fullName, member as Declarable);
    }
  }

  if (shared) {
    for (const entity of result.values()) {
      if ("props" in entity) {
        const existing = entity.props as Record<string, unknown>;
        const merged: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(shared)) {
          if (v !== undefined) {
            merged[k] = v;
          }
        }
        for (const [k, v] of Object.entries(existing)) {
          if (v !== undefined) {
            if (Array.isArray(v) && Array.isArray(merged[k])) {
              merged[k] = [...(merged[k] as unknown[]), ...v];
            } else {
              merged[k] = v;
            }
          }
        }
        Object.defineProperty(entity, "props", {
          value: merged, enumerable: false, configurable: true,
        });
      }
    }
  }

  return result;
}

/**
 * Type helpers for withDefaults.
 */
type PartialByDefault<P, D extends Partial<P>> =
  Omit<P, keyof D> & Partial<Pick<P, keyof D & keyof P>>;
type Simplify<T> = { [K in keyof T]: T[K] };

/**
 * Wraps a CompositeDefinition with pre-applied default values.
 * Props that have defaults become optional in the returned type.
 *
 * ```ts
 * const SecureApi = withDefaults(LambdaApi, { runtime: "nodejs20.x", timeout: 10 });
 * const api = SecureApi({ name: "myApi", code: "./dist" }); // runtime and timeout are optional
 * ```
 */
export function withDefaults<P, M extends CompositeMembers, D extends Partial<P>>(
  definition: CompositeDefinition<P, M>,
  defaults: D,
): CompositeDefinition<Simplify<PartialByDefault<P, D>>, M> {
  const wrapped = ((props: Simplify<PartialByDefault<P, D>>) => {
    return definition({ ...defaults, ...props } as P);
  }) as CompositeDefinition<Simplify<PartialByDefault<P, D>>, M>;

  Object.defineProperty(wrapped, "compositeName", {
    value: definition.compositeName, writable: false,
  });
  Object.defineProperty(wrapped, "_id", {
    value: definition._id, writable: false,
  });

  return wrapped;
}

/**
 * Symbol key for shared props attached by propagate().
 */
export const SHARED_PROPS = Symbol.for("chant.composite.shared");

/**
 * Attaches shared properties to a composite instance.
 * During expandComposite(), shared props are merged into every member's props.
 *
 * Merge semantics:
 * - Scalars: member-specific value wins
 * - Arrays (e.g. tags): concatenate shared + member-specific
 * - undefined values in shared props are stripped
 *
 * ```ts
 * export const storage = propagate(
 *   SecureStorage({ name: "data" }),
 *   { tags: [{ key: "env", value: "prod" }] },
 * );
 * ```
 */
export function propagate<M extends CompositeMembers>(
  instance: CompositeInstance<M> & M,
  sharedProps: Record<string, unknown>,
): CompositeInstance<M> & M {
  Object.defineProperty(instance, SHARED_PROPS, {
    value: sharedProps,
    enumerable: false,
  });
  return instance;
}

/**
 * Marker function for resource declarations within composites.
 * At runtime, simply calls `new Type(props)` and returns the result.
 * Exists so lint tooling can validate composite member construction (EVL005).
 */
export function resource<T extends Declarable, P>(
  Type: new (props: P) => T,
  props: P,
): T {
  return new Type(props);
}
