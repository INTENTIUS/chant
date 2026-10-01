/**
 * The plan `chant import` hands from the parser to the generator: the
 * declarations one dashboard becomes, with the references between them.
 *
 * The parser decides what each piece of dashboard JSON becomes (which
 * class, which props, what cannot be carried) using the tables in
 * `./mappings.ts`. The generator decides only how the plan is written:
 * names, modules, imports, lifted consts. It knows nothing about Grafana,
 * so live export (#2946) can build a plan from a dashboard read over the
 * API and write it with the same generator.
 */

/** A value in a declaration's props that refers to another declaration, written as that declaration's variable. */
export interface DeclRef {
  readonly $decl: string;
}

export function declRef(id: string): DeclRef {
  return { $decl: id };
}

export function isDeclRef(v: unknown): v is DeclRef {
  return typeof v === "object" && v !== null && typeof (v as DeclRef).$decl === "string" && Object.keys(v).length === 1;
}

/**
 * A value written as a call to a function the package exports, e.g.
 * `customTransformation("sortBy", { ... })` for a transformation the typed
 * form can't hold. The arguments are values like any other.
 */
export interface CallValue {
  readonly $call: string;
  readonly args: readonly unknown[];
}

export function callValue(fn: string, args: readonly unknown[]): CallValue {
  return { $call: fn, args };
}

export function isCallValue(v: unknown): v is CallValue {
  return typeof v === "object" && v !== null && typeof (v as CallValue).$call === "string" && Array.isArray((v as CallValue).args) && Object.keys(v).length === 2;
}

/** Where a declaration's variable name comes from: a text to camelCase, or another declaration's name plus a suffix. */
export type NameHint = string | { readonly of: string; readonly suffix: string };

/**
 * One declaration.
 *
 * - `new`: `const name = new ClassName(props);`, a declarable.
 * - `value`: `const name: type = value;`, a plain value other declarations
 *   refer to (a `DatasourceRef`).
 */
export interface Declaration {
  /** Unique in the plan, e.g. `panel:4`, `query:4:A`, `variable:job`, `datasource:prometheus:prom`, `dashboard`. */
  readonly id: string;
  readonly kind: "new" | "value";
  /** For `new`: the class. A package export unless `customClass` says the import declares it. */
  readonly className?: string;
  /** For `new`: the id of the `CustomClass` declaring `className`, when it is not a package export. */
  readonly customClass?: string;
  /**
   * For `new`: type arguments for the class, as TypeScript source. The
   * consts lifted out of the props are typed `PropsOf<typeof Class<...>>`,
   * so a `Datasource<"prometheus">`'s `jsonData` const is typed as
   * Prometheus settings rather than any plugin's.
   */
  readonly typeArguments?: readonly string[];
  /** For `new`: the constructor's props, in source order. */
  readonly props?: Record<string, unknown>;
  /** For `value`: the value, and its type annotation with the package types it names. */
  readonly value?: unknown;
  readonly type?: { readonly text: string; readonly imports: readonly string[] };
  readonly name: NameHint;
  /** The module group it is written to (see `Plan.modules`). */
  readonly module: string;
  /**
   * Declarations with the same unit stay in the same file when a module is
   * split (a panel and its queries). Defaults to the id.
   */
  readonly unit?: string;
  /** Comment lines written above it. */
  readonly comment?: readonly string[];
  /**
   * For `new`: a property-kind declarable (a panel, row, query or variable),
   * which core lint's COR001, COR004 and COR009 leave out (chant #2957). The
   * generator writes it inline, as a `new` expression where it is used, when
   * exactly one declaration in the same file refers to it, the plan does not
   * export it and it has no comment; otherwise it is a const like any other.
   * Either way its nested values stay inline and it does not count toward
   * the declarables per file.
   */
  readonly property?: boolean;
}

/** A panel or query class the import declares, for a plugin chant has no class for. */
export interface CustomClass {
  /** e.g. `panel-class:grafana-clock-panel`, `query-class:elasticsearch`. */
  readonly id: string;
  readonly className: string;
  /** `definePanel` or `defineQuery`. */
  readonly factory: "definePanel" | "defineQuery";
  /** The definition object passed to the factory. */
  readonly definition: Record<string, unknown>;
  readonly comment: readonly string[];
}

/** One module group: a base file name and the doc comment at its top. */
export interface ModuleSpec {
  readonly key: string;
  /** File name without `.ts`; `-1`, `-2`, ... is added when the group is split. */
  readonly file: string;
  readonly summary: string;
  /**
   * Written into `Plan.main`'s file only while that file stays under the
   * generator's line budget; past it, a file of its own (a row and its
   * panels, in a long dashboard).
   */
  readonly separable?: boolean;
}

/** Everything one dashboard becomes. */
export interface Plan {
  /** The directory its modules are written to, relative to the output directory. `""` for none. */
  readonly directory: string;
  /** Modules in the order they are written. */
  readonly modules: readonly ModuleSpec[];
  /** Declarations in dependency order: a declaration only refers to ones before it. */
  readonly declarations: readonly Declaration[];
  readonly customClasses: readonly CustomClass[];
  /** Declarations exported even when no other module imports them (the dashboard). */
  readonly exports: readonly string[];
  /**
   * The module group the others are written into, so the plan is one file
   * where COR009 allows (the dashboard). Without one, every group is a file
   * of its own.
   */
  readonly main?: string;
}
