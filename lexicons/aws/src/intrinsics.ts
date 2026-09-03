import { INTRINSIC_MARKER, resolveIntrinsicValue, isIntrinsic, type Intrinsic } from "@intentius/chant/intrinsic";
import { buildInterpolatedString, defaultInterpolationSerializer } from "@intentius/chant/intrinsic-interpolation";
import { type Declarable } from "@intentius/chant/declarable";
import { getLogicalName } from "@intentius/chant/utils";
import { isCondition, type Condition } from "./condition";

/**
 * An operand allowed where CloudFormation expects a condition (#2068): a
 * nested condition intrinsic (`Equals`/`And`/`Or`/`Not`), the `Condition`
 * declarable itself, or a condition name string. The latter two both emit
 * the `{ "Condition": "<name>" }` reference form.
 */
export type ConditionOperand = Intrinsic | Condition | string;

function resolveConditionOperand(operand: ConditionOperand): unknown {
  if (typeof operand === "string") {
    return { Condition: operand };
  }
  if (isCondition(operand)) {
    return { Condition: getLogicalName(operand) };
  }
  return resolveIntrinsicValue(operand);
}

/**
 * Fn::Sub intrinsic function implementation
 * Supports template string interpolation with AttrRefs, Declarables, and pseudo-parameters
 */
export class SubIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private templateParts: string[];
  private values: unknown[];

  constructor(templateParts: string[], values: unknown[]) {
    this.templateParts = templateParts;
    this.values = values;
  }

  toJSON(): { "Fn::Sub": string } {
    const serialize = defaultInterpolationSerializer(
      (name, attr) => `\${${name}.${attr}}`,
      (ref) => `\${${ref}}`,
    );
    return { "Fn::Sub": buildInterpolatedString(this.templateParts, this.values, serialize) };
  }
}

/**
 * Tagged template function for creating Fn::Sub intrinsics
 * Usage: Sub`${AWS.StackName}-bucket` or Sub`${bucket.arn}`
 */
export function Sub(
  templateParts: TemplateStringsArray,
  ...values: unknown[]
): SubIntrinsic {
  return new SubIntrinsic([...templateParts], values);
}

/**
 * Ref intrinsic function
 * References a parameter or resource by logical name.
 * Accepts either a string name or a Declarable entity (e.g. Parameter).
 * When given a Declarable, the logical name is resolved at serialization time.
 */
export class RefIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private target: string | Declarable;

  constructor(target: string | Declarable) {
    this.target = target;
  }

  toJSON(): { Ref: string } {
    if (typeof this.target === "string") {
      return { Ref: this.target };
    }
    return { Ref: getLogicalName(this.target) };
  }
}

/**
 * Create a Ref intrinsic.
 * Pass a string for direct parameter/resource names, or a Declarable (e.g. Parameter) for type-safe references.
 */
export function Ref(target: string | Declarable): RefIntrinsic {
  return new RefIntrinsic(target);
}

/**
 * Fn::GetAtt intrinsic function
 * Gets an attribute from a resource
 */
export class GetAttIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private logicalName: string;
  private attribute: string;

  constructor(logicalName: string, attribute: string) {
    this.logicalName = logicalName;
    this.attribute = attribute;
  }

  toJSON(): { "Fn::GetAtt": [string, string] } {
    return { "Fn::GetAtt": [this.logicalName, this.attribute] };
  }
}

/**
 * Create a GetAtt intrinsic
 */
export function GetAtt(logicalName: string, attribute: string): GetAttIntrinsic {
  return new GetAttIntrinsic(logicalName, attribute);
}

/**
 * Fn::If intrinsic function
 * Conditional value based on a condition
 */
export class IfIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private conditionName: string | Condition;
  private valueIfTrue: unknown;
  private valueIfFalse: unknown;

  constructor(conditionName: string | Condition, valueIfTrue: unknown, valueIfFalse: unknown) {
    this.conditionName = conditionName;
    this.valueIfTrue = valueIfTrue;
    this.valueIfFalse = valueIfFalse;
  }

  toJSON(): { "Fn::If": [string, unknown, unknown] } {
    const name = typeof this.conditionName === "string" ? this.conditionName : getLogicalName(this.conditionName);
    return { "Fn::If": [name, resolveIntrinsicValue(this.valueIfTrue), resolveIntrinsicValue(this.valueIfFalse)] };
  }
}


/**
 * Create an If intrinsic. The condition is a name string, or the `Condition`
 * declarable itself (resolved to its logical name at serialization, #2068).
 */
export function If(conditionName: string | Condition, valueIfTrue: unknown, valueIfFalse: unknown): IfIntrinsic {
  return new IfIntrinsic(conditionName, valueIfTrue, valueIfFalse);
}

/**
 * Fn::Equals condition intrinsic (#2068).
 * Compares two values; each may be a literal or a value intrinsic (Ref etc.).
 */
export class EqualsIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private left: unknown;
  private right: unknown;

  constructor(left: unknown, right: unknown) {
    this.left = left;
    this.right = right;
  }

  toJSON(): { "Fn::Equals": [unknown, unknown] } {
    return { "Fn::Equals": [resolveIntrinsicValue(this.left), resolveIntrinsicValue(this.right)] };
  }
}

/**
 * Create an Equals condition intrinsic: `Equals(Ref(cutover), "true")`.
 */
export function Equals(left: unknown, right: unknown): EqualsIntrinsic {
  return new EqualsIntrinsic(left, right);
}

/**
 * Fn::And condition intrinsic (#2068).
 */
export class AndIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private conditions: ConditionOperand[];

  constructor(conditions: ConditionOperand[]) {
    this.conditions = conditions;
  }

  toJSON(): { "Fn::And": unknown[] } {
    return { "Fn::And": this.conditions.map(resolveConditionOperand) };
  }
}

/**
 * Create an And condition intrinsic over 2–10 operands, each a nested
 * condition intrinsic, a `Condition` declarable, or a condition name.
 */
export function And(...conditions: ConditionOperand[]): AndIntrinsic {
  if (conditions.length < 2 || conditions.length > 10) {
    throw new Error("And(...conditions): Fn::And takes between 2 and 10 conditions");
  }
  return new AndIntrinsic(conditions);
}

/**
 * Fn::Or condition intrinsic (#2068).
 */
export class OrIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private conditions: ConditionOperand[];

  constructor(conditions: ConditionOperand[]) {
    this.conditions = conditions;
  }

  toJSON(): { "Fn::Or": unknown[] } {
    return { "Fn::Or": this.conditions.map(resolveConditionOperand) };
  }
}

/**
 * Create an Or condition intrinsic over 2–10 operands, each a nested
 * condition intrinsic, a `Condition` declarable, or a condition name.
 */
export function Or(...conditions: ConditionOperand[]): OrIntrinsic {
  if (conditions.length < 2 || conditions.length > 10) {
    throw new Error("Or(...conditions): Fn::Or takes between 2 and 10 conditions");
  }
  return new OrIntrinsic(conditions);
}

/**
 * Fn::Not condition intrinsic (#2068).
 */
export class NotIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private condition: ConditionOperand;

  constructor(condition: ConditionOperand) {
    this.condition = condition;
  }

  toJSON(): { "Fn::Not": [unknown] } {
    return { "Fn::Not": [resolveConditionOperand(this.condition)] };
  }
}

/**
 * Create a Not condition intrinsic over a nested condition intrinsic, a
 * `Condition` declarable, or a condition name.
 */
export function Not(condition: ConditionOperand): NotIntrinsic {
  return new NotIntrinsic(condition);
}

/**
 * Fn::Join intrinsic function
 * Joins values with a delimiter
 */
export class JoinIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private delimiter: string;
  private values: unknown[] | Intrinsic;

  constructor(delimiter: string, values: unknown[] | Intrinsic) {
    this.delimiter = delimiter;
    this.values = values;
  }

  toJSON(): { "Fn::Join": [string, unknown] } {
    // Fn::Join's second arg is either a literal list of values OR a single
    // list-returning intrinsic (GetAtt of a list attr, Split, Ref to a List<>
    // param). Only the array form gets `.map`; a lone intrinsic is emitted as-is
    // (#517 — mapping over it dereferenced undefined and crashed the build).
    const list = Array.isArray(this.values)
      ? this.values.map(resolveIntrinsicValue)
      : resolveIntrinsicValue(this.values);
    return { "Fn::Join": [this.delimiter, list] };
  }
}

/**
 * Create a Join intrinsic. `values` is a literal array, or a single
 * list-returning intrinsic (e.g. `Join(",", zone.NameServers)`).
 */
export function Join(delimiter: string, values: unknown[] | Intrinsic): JoinIntrinsic {
  if (!Array.isArray(values) && !isIntrinsic(values)) {
    throw new Error(
      "Join(delimiter, values): values must be an array or a list-returning intrinsic (GetAtt/Split/Ref to a List)",
    );
  }
  return new JoinIntrinsic(delimiter, values);
}

/**
 * Fn::Select intrinsic function
 * Selects a value from a list by index
 */
export class SelectIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private index: number;
  private values: unknown[] | Intrinsic;

  constructor(index: number, values: unknown[] | Intrinsic) {
    this.index = index;
    this.values = values;
  }

  toJSON(): { "Fn::Select": [string, unknown] } {
    const resolvedValues = Array.isArray(this.values)
      ? this.values.map(resolveIntrinsicValue)
      : (this.values as Intrinsic & { toJSON(): unknown }).toJSON();
    return { "Fn::Select": [String(this.index), resolvedValues] };
  }
}

/**
 * Create a Select intrinsic
 */
export function Select(index: number, values: unknown[] | Intrinsic): SelectIntrinsic {
  return new SelectIntrinsic(index, values);
}

/**
 * Fn::Split intrinsic function
 * Splits a string by delimiter
 */
export class SplitIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private delimiter: string;
  private source: string | Intrinsic;

  constructor(delimiter: string, source: string | Intrinsic) {
    this.delimiter = delimiter;
    this.source = source;
  }

  toJSON(): { "Fn::Split": [string, unknown] } {
    const sourceValue = typeof this.source === "string"
      ? this.source
      : (this.source as Intrinsic & { toJSON(): unknown }).toJSON();
    return { "Fn::Split": [this.delimiter, sourceValue] };
  }
}

/**
 * Create a Split intrinsic
 */
export function Split(delimiter: string, source: string | Intrinsic): SplitIntrinsic {
  return new SplitIntrinsic(delimiter, source);
}

/**
 * Fn::Base64 intrinsic function
 * Encodes a string to Base64
 */
export class Base64Intrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private value: string | Intrinsic;

  constructor(value: string | Intrinsic) {
    this.value = value;
  }

  toJSON(): { "Fn::Base64": unknown } {
    const innerValue = typeof this.value === "string"
      ? this.value
      : (this.value as Intrinsic & { toJSON(): unknown }).toJSON();
    return { "Fn::Base64": innerValue };
  }
}

/**
 * Create a Base64 intrinsic
 */
export function Base64(value: string | Intrinsic): Base64Intrinsic {
  return new Base64Intrinsic(value);
}

/**
 * Fn::GetAZs intrinsic function
 * Returns a list of Availability Zones for a region
 */
export class GetAZsIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private region: string | Intrinsic;

  constructor(region: string | Intrinsic = "") {
    this.region = region;
  }

  toJSON(): { "Fn::GetAZs": unknown } {
    const regionValue = typeof this.region === "string"
      ? this.region
      : (this.region as Intrinsic & { toJSON(): unknown }).toJSON();
    return { "Fn::GetAZs": regionValue };
  }
}

/**
 * Create a GetAZs intrinsic
 */
export function GetAZs(region?: string | Intrinsic): GetAZsIntrinsic {
  return new GetAZsIntrinsic(region);
}
