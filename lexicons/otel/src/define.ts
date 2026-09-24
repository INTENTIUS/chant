/**
 * `defineComponent()`, the one way a collector component type enters this
 * lexicon.
 *
 * The built-in receivers, processors, exporters and extensions are defined
 * through it, and so is a component a team or plugin adds for something chant
 * doesn't ship (a vendor exporter, an in-house processor). Both produce the
 * same kind of class, register in the same table, serialize through the same
 * code and are checked by the same post-synth checks, so there is no second
 * path for a custom component to fall off.
 *
 * ## Schema pinning
 *
 * Every definition carries a `pin`: the source its config type was written
 * against and the version of that source. Built-ins share `COLLECTOR_PIN`,
 * which moves only when this package does, so the chant lexicon version pins
 * them. A custom definition must name its own pin, typically the npm package
 * (or Go module) that ships the component and the release its type follows,
 * optionally with a digest of the schema document. chant records the pin; it
 * does not fetch or verify the schema. The pin shows up in three places:
 *
 * - `collectorTopology()` reports it for every component, built-in or not.
 * - The serializer writes a `# chant:` comment line per custom component at
 *   the top of the emitted YAML, so the file says which schema each
 *   non-built-in component was checked against. The collector ignores it.
 * - OTEL109 fails a build whose custom component has no usable pin.
 */

import { createResource } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import { componentId, type ComponentKind } from "./model";

/** Where a component's config schema comes from, and which version of it the type follows. */
export interface SchemaPin {
  /** The package, Go module or URL that defines the component's config, e.g. `@acme/otel-datadog`. */
  source: string;
  /** The version of `source` the TypeScript config type was written against. */
  version: string;
  /** Optional digest of the schema document itself, e.g. `sha256:…`. Recorded as given. */
  digest?: string;
}

/**
 * The collector distribution the built-in config types follow. Bumping it is a
 * lexicon change like any other, released with this package.
 */
export const COLLECTOR_PIN: SchemaPin = Object.freeze({
  source: "github.com/open-telemetry/opentelemetry-collector-contrib",
  version: "v0.130.0",
});

/** A zod-compatible schema: anything with `safeParse`. Keeps zod optional. */
export interface SafeParseSchema {
  safeParse(value: unknown): {
    success: boolean;
    error?: { issues?: Array<{ path?: ReadonlyArray<PropertyKey>; message: string }>; message?: string };
  };
}

/** A config check: a function returning problems, or a zod-compatible schema. */
export type ConfigValidator<C> = ((config: C) => string[]) | SafeParseSchema;

export interface ComponentDefinition<K extends ComponentKind = ComponentKind, T extends string = string, C = Record<string, unknown>> {
  kind: K;
  /** The collector type, the part of the id before `/`. */
  type: T;
  /** Where the config schema comes from. Required for a custom component. */
  pin: SchemaPin;
  /** True only for the components this package ships. */
  builtin: boolean;
  /** One line for hover and docs. */
  description?: string;
  /** Extra checks on the config beyond what its TypeScript type enforces (OTEL107). */
  validate?: ConfigValidator<C>;
  /** Where this component sends or listens, for `collectorTopology()`. */
  endpoints?: (config: C) => string[];
}

/** What a custom component supplies. `builtin` is always false for these. */
export type CustomComponentOptions<K extends ComponentKind, T extends string, C> = Omit<
  ComponentDefinition<K, T, C>,
  "builtin"
>;

/** Constructor props: the component's own config plus the optional instance `name`. */
export type ComponentProps<C> = C & {
  /** The instance name. The component id becomes `type/name`; without it the id is just `type`. */
  name?: string;
};

/** A declared collector component. */
export interface OTelComponent<K extends ComponentKind = ComponentKind, T extends string = string, C = Record<string, unknown>>
  extends Declarable {
  readonly props: ComponentProps<C>;
  readonly componentKind: K;
  readonly componentType: T;
  /** The collector id, `type` or `type/name`. */
  readonly componentId: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type CtorArgs<C> = {} extends C ? [props?: ComponentProps<C>] : [props: ComponentProps<C>];

export interface ComponentClass<K extends ComponentKind = ComponentKind, T extends string = string, C = Record<string, unknown>> {
  new (...args: CtorArgs<C>): OTelComponent<K, T, C>;
  readonly definition: ComponentDefinition<K, T, C>;
}

const KIND_SEGMENT: Record<ComponentKind, string> = {
  receiver: "Receiver",
  processor: "Processor",
  exporter: "Exporter",
  extension: "Extension",
};

/** The chant entity type for a component, e.g. `OTel::Exporter::otlp`. */
export function componentEntityType(kind: ComponentKind, type: string): string {
  return `OTel::${KIND_SEGMENT[kind]}::${type}`;
}

// One table per process, keyed by entity type. Held on globalThis so a second
// copy of this module (a test runner and a built dist, say) shares it.
const REGISTRY_KEY = Symbol.for("chant.otel.componentDefinitions");
function registry(): Map<string, ComponentDefinition> {
  const g = globalThis as unknown as Record<symbol, Map<string, ComponentDefinition> | undefined>;
  let table = g[REGISTRY_KEY];
  if (!table) {
    table = new Map();
    g[REGISTRY_KEY] = table;
  }
  return table;
}

/** The definition behind an entity type, if one has been registered in this process. */
export function definitionFor(entityType: string): ComponentDefinition | undefined {
  return registry().get(entityType);
}

/** The definition for a collector `kind` + `type`, e.g. the built-in `exporter` `otlp`. */
export function definitionOf(kind: ComponentKind, type: string): ComponentDefinition | undefined {
  return registry().get(componentEntityType(kind, type));
}

/** Every registered definition, built-ins first in registration order. */
export function registeredDefinitions(): ComponentDefinition[] {
  return [...registry().values()];
}

const TYPE_PATTERN = /^[A-Za-z0-9_]+$/;

function makeClass<K extends ComponentKind, T extends string, C>(
  def: ComponentDefinition<K, T, C>,
): ComponentClass<K, T, C> {
  if (!TYPE_PATTERN.test(def.type)) {
    throw new Error(`otel: component type "${def.type}" is not a collector type (letters, digits and _ only)`);
  }
  const entityType = componentEntityType(def.kind, def.type);
  const existing = registry().get(entityType);
  if (existing?.builtin && !def.builtin) {
    throw new Error(
      `otel: ${def.kind} "${def.type}" is built in. Declare an instance with a name (${def.type}/<name>) instead of defining it again.`,
    );
  }
  registry().set(entityType, def as unknown as ComponentDefinition);

  const Base = createResource(entityType, "otel", {}) as unknown as (this: object, props: Record<string, unknown>) => void;
  const Cls = function (this: object, props?: Record<string, unknown>) {
    const p = props ?? {};
    Base.call(this, p);
    const name = typeof p.name === "string" ? p.name : undefined;
    Object.defineProperty(this, "componentKind", { value: def.kind, enumerable: false });
    Object.defineProperty(this, "componentType", { value: def.type, enumerable: false });
    Object.defineProperty(this, "componentId", { value: componentId(def.type, name), enumerable: false });
  };
  Object.defineProperty(Cls, "name", { value: `${def.type}${KIND_SEGMENT[def.kind]}` });
  Object.defineProperty(Cls, "definition", { value: def, enumerable: false });
  return Cls as unknown as ComponentClass<K, T, C>;
}

/** Internal: how the built-ins in `./components` are defined. */
export function defineBuiltin<C, K extends ComponentKind = ComponentKind, T extends string = string>(
  def: Omit<ComponentDefinition<K, T, C>, "builtin" | "pin">,
): ComponentClass<K, T, C> {
  return makeClass<K, T, C>({ ...def, pin: COLLECTOR_PIN, builtin: true });
}

/**
 * Define a collector component chant doesn't ship.
 *
 * @example
 * ```ts
 * interface DatadogExporterConfig {
 *   api: { key: string; site?: string };
 *   traces?: { span_name_as_resource_name?: boolean };
 * }
 *
 * export const DatadogExporter = defineComponent<DatadogExporterConfig>()({
 *   kind: "exporter",
 *   type: "datadog",
 *   pin: { source: "github.com/open-telemetry/opentelemetry-collector-contrib/exporter/datadogexporter", version: "v0.130.0" },
 *   validate: (c) => (c.api.key.startsWith("${env:") ? [] : ["api.key should come from ${env:...}"]),
 *   endpoints: (c) => [`https://api.${c.api.site ?? "datadoghq.com"}`],
 * });
 *
 * export const dd = new DatadogExporter({ api: { key: "${env:DD_API_KEY}" } });
 * ```
 *
 * The curried form lets you name the config type while `kind` and `type` are
 * still inferred from the literal you pass.
 */
export function defineComponent<C>() {
  return function <K extends ComponentKind, T extends string>(
    options: CustomComponentOptions<K, T, C>,
  ): ComponentClass<K, T, C> {
    return makeClass<K, T, C>({ ...options, builtin: false });
  };
}

/** True when `value` is a declared collector component (built-in or custom). */
export function isOTelComponent(value: unknown): value is OTelComponent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { componentKind?: unknown }).componentKind === "string" &&
    typeof (value as { componentId?: unknown }).componentId === "string" &&
    (value as { lexicon?: unknown }).lexicon === "otel"
  );
}

/** Run a definition's validator, normalising both validator forms to a list of messages. */
export function runValidator<C>(validator: ConfigValidator<C> | undefined, config: C): string[] {
  if (!validator) return [];
  if (typeof validator === "function") return validator(config);
  const result = validator.safeParse(config);
  if (result.success) return [];
  const issues = result.error?.issues ?? [];
  if (issues.length === 0) return [result.error?.message ?? "config does not match its schema"];
  return issues.map((i) => {
    const path = (i.path ?? []).map(String).join(".");
    return path ? `${path}: ${i.message}` : i.message;
  });
}

/** A pin is usable when it names a source and a version. */
export function isUsablePin(pin: unknown): pin is SchemaPin {
  if (typeof pin !== "object" || pin === null) return false;
  const p = pin as Record<string, unknown>;
  return typeof p.source === "string" && p.source.trim() !== "" && typeof p.version === "string" && p.version.trim() !== "";
}
