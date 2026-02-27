/**
 * ARM template function intrinsics.
 *
 * Each intrinsic implements INTRINSIC_MARKER + toJSON() for serialization
 * to ARM template bracket expressions: "[resourceId(...)]", "[concat(...)]", etc.
 */

import { INTRINSIC_MARKER, resolveIntrinsicValue, type Intrinsic } from "@intentius/chant/intrinsic";

/**
 * resourceId(resourceType, name1, name2, ...) — returns a resource ID string.
 */
export class ResourceIdIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private resourceType: string;
  private names: unknown[];

  constructor(resourceType: string, ...names: unknown[]) {
    this.resourceType = resourceType;
    this.names = names;
  }

  toJSON(): string {
    const args = [
      `'${this.resourceType}'`,
      ...this.names.map((n) => serializeArg(n)),
    ].join(", ");
    return `[resourceId(${args})]`;
  }
}

export function ResourceId(resourceType: string, ...names: unknown[]): ResourceIdIntrinsic {
  return new ResourceIdIntrinsic(resourceType, ...names);
}

/**
 * reference(name, apiVersion?) — returns the runtime state of a resource.
 */
export class ReferenceIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private name: string;
  private apiVersion?: string;

  constructor(name: string, apiVersion?: string) {
    this.name = name;
    this.apiVersion = apiVersion;
  }

  toJSON(): string {
    if (this.apiVersion) {
      return `[reference('${this.name}', '${this.apiVersion}')]`;
    }
    return `[reference('${this.name}')]`;
  }
}

export function Reference(name: string, apiVersion?: string): ReferenceIntrinsic {
  return new ReferenceIntrinsic(name, apiVersion);
}

/**
 * concat(value1, value2, ...) — concatenates strings.
 */
export class ConcatIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private values: unknown[];

  constructor(...values: unknown[]) {
    this.values = values;
  }

  toJSON(): string {
    const args = this.values.map((v) => serializeArg(v)).join(", ");
    return `[concat(${args})]`;
  }
}

export function Concat(...values: unknown[]): ConcatIntrinsic {
  return new ConcatIntrinsic(...values);
}

/**
 * resourceGroup() — returns the current resource group object.
 */
export class ResourceGroupIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;

  toJSON(): string {
    return "[resourceGroup()]";
  }
}

export function ResourceGroup(): ResourceGroupIntrinsic {
  return new ResourceGroupIntrinsic();
}

/**
 * subscription() — returns the current subscription object.
 */
export class SubscriptionIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;

  toJSON(): string {
    return "[subscription()]";
  }
}

export function Subscription(): SubscriptionIntrinsic {
  return new SubscriptionIntrinsic();
}

/**
 * uniqueString(value1, ...) — generates a deterministic hash string.
 */
export class UniqueStringIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private values: unknown[];

  constructor(...values: unknown[]) {
    this.values = values;
  }

  toJSON(): string {
    const args = this.values.map((v) => serializeArg(v)).join(", ");
    return `[uniqueString(${args})]`;
  }
}

export function UniqueString(...values: unknown[]): UniqueStringIntrinsic {
  return new UniqueStringIntrinsic(...values);
}

/**
 * format(formatString, arg1, arg2, ...) — formats a string.
 */
export class FormatIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private fmt: string;
  private args: unknown[];

  constructor(fmt: string, ...args: unknown[]) {
    this.fmt = fmt;
    this.args = args;
  }

  toJSON(): string {
    const allArgs = [`'${this.fmt}'`, ...this.args.map((a) => serializeArg(a))].join(", ");
    return `[format(${allArgs})]`;
  }
}

export function Format(fmt: string, ...args: unknown[]): FormatIntrinsic {
  return new FormatIntrinsic(fmt, ...args);
}

/**
 * if(condition, trueValue, falseValue) — conditional expression.
 */
export class IfIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private condition: string;
  private trueValue: unknown;
  private falseValue: unknown;

  constructor(condition: string, trueValue: unknown, falseValue: unknown) {
    this.condition = condition;
    this.trueValue = trueValue;
    this.falseValue = falseValue;
  }

  toJSON(): string {
    return `[if('${this.condition}', ${serializeArg(this.trueValue)}, ${serializeArg(this.falseValue)})]`;
  }
}

export function If(condition: string, trueValue: unknown, falseValue: unknown): IfIntrinsic {
  return new IfIntrinsic(condition, trueValue, falseValue);
}

/**
 * listKeys(resourceId, apiVersion) — lists access keys for a resource.
 */
export class ListKeysIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private resourceId: unknown;
  private apiVersion: string;

  constructor(resourceId: unknown, apiVersion: string) {
    this.resourceId = resourceId;
    this.apiVersion = apiVersion;
  }

  toJSON(): string {
    return `[listKeys(${serializeArg(this.resourceId)}, '${this.apiVersion}')]`;
  }
}

export function ListKeys(resourceId: unknown, apiVersion: string): ListKeysIntrinsic {
  return new ListKeysIntrinsic(resourceId, apiVersion);
}

// --- Helpers ---

function serializeArg(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const resolved = resolveIntrinsicValue(value);
  if (typeof resolved === "string" && resolved.startsWith("[") && resolved.endsWith("]")) {
    // Nested ARM expression — strip outer brackets
    return resolved.slice(1, -1);
  }
  return JSON.stringify(resolved);
}
