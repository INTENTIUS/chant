import { Composite, mergeDefaults, type Value } from "@intentius/chant";
import {
  ECRRepository,
  ECRRepository_EncryptionConfiguration,
  ECRRepository_ImageScanningConfiguration,
  ECRRepository_LifecyclePolicy,
} from "../generated";

export interface EcrLifecycleRule {
  /** Rules are evaluated in ascending priority order; each image is matched by exactly one rule. */
  rulePriority: number;
  description?: string;
  /** Defaults to "any" — matches every image regardless of tag state. */
  tagStatus?: "tagged" | "untagged" | "any";
  /** Only meaningful with tagStatus "tagged". */
  tagPrefixList?: string[];
  /** Only meaningful with tagStatus "tagged". */
  tagPatternList?: string[];
  countType: "imageCountMoreThan" | "sinceImagePushed";
  /** Required (and only meaningful) with countType "sinceImagePushed". */
  countUnit?: "days";
  countNumber: number;
}

export interface EcrEncryption {
  /** Defaults to "AES256" (Amazon S3-managed keys) when this block is provided without a type. */
  type?: "AES256" | "KMS" | "KMS_DSSE";
  /** KMS/KMS_DSSE only. Falls back to the default AWS-managed ECR key when omitted. */
  kmsKeyId?: string;
}

export interface EcrRepositoryProps {
  /** `Value<string>`: a name is routinely built with `Sub`/`Ref` (#1366). Omitted, CloudFormation generates one. */
  repositoryName?: Value<string>;
  imageTagMutability?: "MUTABLE" | "IMMUTABLE" | "MUTABLE_WITH_EXCLUSION" | "IMMUTABLE_WITH_EXCLUSION";
  /** Defaults to true — scanning freshly pushed images is the safe default for a new repository. */
  scanOnPush?: boolean;
  /**
   * Lifecycle rules, evaluated in `rulePriority` order and rendered into the repository's
   * `LifecyclePolicyText`. Defaults to a single "expire untagged images after 14 days" rule
   * -- AWS's own starter policy -- when omitted. Pass `[]` to ship the repository with no
   * lifecycle policy at all.
   */
  lifecycleRules?: EcrLifecycleRule[];
  encryption?: EcrEncryption;
  /** If true, deleting the repository force-deletes its contents instead of requiring it to be empty first. */
  emptyOnDelete?: boolean;
  /** JSON repository policy document (cross-account pull access, etc). */
  repositoryPolicy?: Record<string, unknown>;
  defaults?: {
    repository?: Partial<ConstructorParameters<typeof ECRRepository>[0]>;
  };
}

const DEFAULT_LIFECYCLE_RULES: EcrLifecycleRule[] = [
  {
    rulePriority: 1,
    description: "Expire untagged images after 14 days",
    tagStatus: "untagged",
    countType: "sinceImagePushed",
    countUnit: "days",
    countNumber: 14,
  },
];

function toLifecyclePolicyText(rules: EcrLifecycleRule[]): string {
  return JSON.stringify({
    rules: rules.map((rule) => ({
      rulePriority: rule.rulePriority,
      ...(rule.description ? { description: rule.description } : {}),
      selection: {
        tagStatus: rule.tagStatus ?? "any",
        ...(rule.tagPrefixList ? { tagPrefixList: rule.tagPrefixList } : {}),
        ...(rule.tagPatternList ? { tagPatternList: rule.tagPatternList } : {}),
        countType: rule.countType,
        ...(rule.countUnit ? { countUnit: rule.countUnit } : {}),
        countNumber: rule.countNumber,
      },
      action: { type: "expire" },
    })),
  });
}

export const EcrRepository = Composite((props: EcrRepositoryProps) => {
  const { defaults } = props;
  const scanOnPush = props.scanOnPush ?? true;
  const lifecycleRules = props.lifecycleRules ?? DEFAULT_LIFECYCLE_RULES;

  const repository = new ECRRepository(mergeDefaults({
    RepositoryName: props.repositoryName,
    ImageTagMutability: props.imageTagMutability,
    EmptyOnDelete: props.emptyOnDelete,
    ImageScanningConfiguration: new ECRRepository_ImageScanningConfiguration({ ScanOnPush: scanOnPush }),
    ...(lifecycleRules.length > 0
      ? { LifecyclePolicy: new ECRRepository_LifecyclePolicy({ LifecyclePolicyText: toLifecyclePolicyText(lifecycleRules) }) }
      : {}),
    ...(props.encryption
      ? {
          EncryptionConfiguration: new ECRRepository_EncryptionConfiguration({
            EncryptionType: props.encryption.type ?? "AES256",
            ...(props.encryption.kmsKeyId ? { KmsKey: props.encryption.kmsKeyId } : {}),
          }),
        }
      : {}),
    ...(props.repositoryPolicy ? { RepositoryPolicyText: props.repositoryPolicy } : {}),
  }, defaults?.repository));

  return { repository };
}, "EcrRepository");
