import { describe, test, expect } from "vitest";
import { expandComposite } from "@intentius/chant";
import { EcrRepository } from "./ecr-repository";

// Generated property-kind instances (ECRRepository_ImageScanningConfiguration, ...) store
// their data on a non-enumerable `.props`, so `toEqual` against a plain object
// compares empty own-enumerable-property sets unless each instance is unwrapped first.
const p = (x: any) => x.props;

describe("EcrRepository", () => {
  test("no props: single member, scan-on-push defaults on, default lifecycle policy present", () => {
    const instance = EcrRepository({});
    expect(Object.keys(instance.members)).toEqual(["repository"]);
    const props = (instance.repository as any).props;
    expect(p(props.ImageScanningConfiguration)).toEqual({ ScanOnPush: true });
    expect(props.LifecyclePolicy).toBeDefined();
  });

  test("expandComposite produces the repository's logical name", () => {
    const expanded = expandComposite("app", EcrRepository({}));
    expect(expanded.has("appRepository")).toBe(true);
    expect(expanded.size).toBe(1);
  });

  test("default lifecycle policy expires untagged images after 14 days", () => {
    const props = (EcrRepository({}).repository as any).props;
    const policy = JSON.parse(p(props.LifecyclePolicy).LifecyclePolicyText);
    expect(policy.rules).toEqual([{
      rulePriority: 1,
      description: "Expire untagged images after 14 days",
      selection: { tagStatus: "untagged", countType: "sinceImagePushed", countUnit: "days", countNumber: 14 },
      action: { type: "expire" },
    }]);
  });

  test("scanOnPush: false is threaded through, not just omitted", () => {
    const props = (EcrRepository({ scanOnPush: false }).repository as any).props;
    expect(p(props.ImageScanningConfiguration)).toEqual({ ScanOnPush: false });
  });

  test("empty lifecycleRules array ships the repository with no lifecycle policy at all", () => {
    const props = (EcrRepository({ lifecycleRules: [] }).repository as any).props;
    expect(props.LifecyclePolicy).toBeUndefined();
  });

  test("custom lifecycle rules render selection and action, omitting unset optional fields", () => {
    const props = (EcrRepository({
      lifecycleRules: [
        { rulePriority: 1, tagStatus: "tagged", tagPrefixList: ["v"], countType: "imageCountMoreThan", countNumber: 10 },
      ],
    }).repository as any).props;
    const policy = JSON.parse(p(props.LifecyclePolicy).LifecyclePolicyText);
    expect(policy.rules).toEqual([{
      rulePriority: 1,
      selection: { tagStatus: "tagged", tagPrefixList: ["v"], countType: "imageCountMoreThan", countNumber: 10 },
      action: { type: "expire" },
    }]);
  });

  test("multiple lifecycle rules keep rulePriority order", () => {
    const props = (EcrRepository({
      lifecycleRules: [
        { rulePriority: 1, tagStatus: "tagged", tagPrefixList: ["prod"], countType: "imageCountMoreThan", countNumber: 20 },
        { rulePriority: 2, tagStatus: "untagged", countType: "sinceImagePushed", countUnit: "days", countNumber: 7 },
      ],
    }).repository as any).props;
    const policy = JSON.parse(p(props.LifecyclePolicy).LifecyclePolicyText);
    expect(policy.rules.map((r: any) => r.rulePriority)).toEqual([1, 2]);
  });

  test("no encryption block by default", () => {
    const props = (EcrRepository({}).repository as any).props;
    expect(props.EncryptionConfiguration).toBeUndefined();
  });

  test("encryption defaults its type to AES256 when only kmsKeyId-less block is given", () => {
    const props = (EcrRepository({ encryption: {} }).repository as any).props;
    expect(p(props.EncryptionConfiguration)).toEqual({ EncryptionType: "AES256" });
  });

  test("KMS encryption threads the key id through", () => {
    const props = (EcrRepository({
      encryption: { type: "KMS", kmsKeyId: "alias/my-key" },
    }).repository as any).props;
    expect(p(props.EncryptionConfiguration)).toEqual({ EncryptionType: "KMS", KmsKey: "alias/my-key" });
  });

  test("repositoryName is threaded through when given", () => {
    const props = (EcrRepository({ repositoryName: "my-app" }).repository as any).props;
    expect(props.RepositoryName).toBe("my-app");
  });

  test("imageTagMutability is threaded through; omitted when not set", () => {
    const withIt = (EcrRepository({ imageTagMutability: "IMMUTABLE" }).repository as any).props;
    expect(withIt.ImageTagMutability).toBe("IMMUTABLE");

    const withoutIt = (EcrRepository({}).repository as any).props;
    expect(withoutIt.ImageTagMutability).toBeUndefined();
  });

  test("repositoryPolicy is threaded through as RepositoryPolicyText", () => {
    const policy = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "ecr:GetDownloadUrlForLayer" }] };
    const props = (EcrRepository({ repositoryPolicy: policy }).repository as any).props;
    expect(props.RepositoryPolicyText).toEqual(policy);
  });

  test("emptyOnDelete is threaded through", () => {
    const props = (EcrRepository({ emptyOnDelete: true }).repository as any).props;
    expect(props.EmptyOnDelete).toBe(true);
  });

  test("defaults escape hatch reaches the repository (e.g. tags)", () => {
    const props = (EcrRepository({
      defaults: { repository: { Tags: [{ Key: "team", Value: "platform" } as any] } },
    }).repository as any).props;
    expect(props.Tags).toEqual([{ Key: "team", Value: "platform" }]);
  });
});
