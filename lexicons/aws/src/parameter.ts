import { DECLARABLE_MARKER, type CoreParameter } from "@intentius/chant/declarable";

/**
 * What CloudFormation checks a parameter value against. Numeric bounds are
 * kept as written: templates write `MinLength: "1"` as often as `1`.
 */
export interface ParameterConstraints {
  allowedValues?: unknown[];
  allowedPattern?: string;
  constraintDescription?: string;
  minLength?: number | string;
  maxLength?: number | string;
  minValue?: number | string;
  maxValue?: number | string;
  noEcho?: boolean | string;
}

export class Parameter implements CoreParameter {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "aws";
  readonly entityType = "AWS::CloudFormation::Parameter";
  readonly parameterType: string;
  readonly description?: string;
  readonly defaultValue?: unknown;
  readonly constraints?: ParameterConstraints;

  constructor(type: string, options?: { description?: string; defaultValue?: unknown } & ParameterConstraints) {
    this.parameterType = type;
    this.description = options?.description;
    this.defaultValue = options?.defaultValue;
    if (options) {
      const { description: _d, defaultValue: _v, ...constraints } = options;
      const set = Object.entries(constraints).filter(([, v]) => v !== undefined);
      if (set.length > 0) this.constraints = Object.fromEntries(set) as ParameterConstraints;
    }
  }
}
