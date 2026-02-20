import { DECLARABLE_MARKER, type CoreParameter } from "@intentius/chant/declarable";

export class Parameter implements CoreParameter {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "aws";
  readonly entityType = "AWS::CloudFormation::Parameter";
  readonly parameterType: string;
  readonly description?: string;
  readonly defaultValue?: unknown;

  constructor(type: string, options?: { description?: string; defaultValue?: unknown }) {
    this.parameterType = type;
    this.description = options?.description;
    this.defaultValue = options?.defaultValue;
  }
}
