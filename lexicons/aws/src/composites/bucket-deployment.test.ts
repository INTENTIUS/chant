import { describe, test, expect } from "vitest";
import { BucketDeployment } from "./bucket-deployment";

describe("BucketDeployment", () => {
  test("private-by-default: encrypted, public access fully blocked, retained on delete, no policy member", () => {
    const c = BucketDeployment({});
    expect(c.bucket).toBeDefined();
    expect((c as unknown as Record<string, unknown>).bucketPolicy).toBeUndefined();

    const props = (c.bucket as any).props;
    expect(props.BucketEncryption.props.ServerSideEncryptionConfiguration).toHaveLength(1);
    expect(props.PublicAccessBlockConfiguration.props).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(props.VersioningConfiguration).toBeUndefined();
    expect(props.WebsiteConfiguration).toBeUndefined();

    const attrs = (c.bucket as any).attributes;
    expect(attrs.DeletionPolicy).toBe("Retain");
  });

  test("bucketName threads through, versioning enables Status: Enabled", () => {
    const c = BucketDeployment({ bucketName: "my-content-bucket", versioned: true });
    const props = (c.bucket as any).props;
    expect(props.BucketName).toBe("my-content-bucket");
    expect(props.VersioningConfiguration.props).toEqual({ Status: "Enabled" });
  });

  test("removalPolicy: destroy maps to DeletionPolicy: Delete", () => {
    const c = BucketDeployment({ removalPolicy: "destroy" });
    expect((c.bucket as any).attributes.DeletionPolicy).toBe("Delete");
  });

  test("website shape: opens the public-access block, sets WebsiteConfiguration, and attaches a scoped public-read bucketPolicy", () => {
    const c = BucketDeployment({
      website: { indexDocument: "index.html", errorDocument: "error.html" },
    }) as unknown as { bucket: any; bucketPolicy: any };

    const bucketProps = c.bucket.props;
    expect(bucketProps.PublicAccessBlockConfiguration.props).toEqual({
      BlockPublicAcls: false,
      BlockPublicPolicy: false,
      IgnorePublicAcls: false,
      RestrictPublicBuckets: false,
    });
    expect(bucketProps.WebsiteConfiguration.props).toEqual({
      IndexDocument: "index.html",
      ErrorDocument: "error.html",
    });

    expect(c.bucketPolicy).toBeDefined();
    expect(c.bucketPolicy.props.Bucket).toBe(c.bucket); // bucket.Ref is the resource instance itself
    const statement = c.bucketPolicy.props.PolicyDocument.Statement[0];
    expect(statement).toEqual({ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: expect.anything() });
  });

  test("website without errorDocument omits it rather than writing undefined", () => {
    const c = BucketDeployment({ website: { indexDocument: "index.html" } });
    const websiteProps = (c.bucket as any).props.WebsiteConfiguration.props;
    expect(websiteProps).toEqual({ IndexDocument: "index.html" });
    expect("ErrorDocument" in websiteProps).toBe(false);
  });

  test("tags pass straight through to the bucket", () => {
    const c = BucketDeployment({ tags: [{ Key: "env", Value: "prod" }] });
    expect((c.bucket as any).props.Tags).toEqual([{ Key: "env", Value: "prod" }]);
  });

  test("defaults escape hatch reaches the bucket (e.g. object-lock)", () => {
    const c = BucketDeployment({ defaults: { bucket: { ObjectLockEnabled: true } } });
    expect((c.bucket as any).props.ObjectLockEnabled).toBe(true);
  });

  test("defaults escape hatch reaches the bucket policy", () => {
    const c = BucketDeployment({
      website: { indexDocument: "index.html" },
      defaults: { bucketPolicy: { Bucket: "explicit-bucket-name" } },
    }) as unknown as { bucketPolicy: any };
    expect(c.bucketPolicy.props.Bucket).toBe("explicit-bucket-name");
  });
});
