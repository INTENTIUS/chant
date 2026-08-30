import { describe, test, expect } from "vitest";
import { AWS_CARVE_TYPES, AWS_FOLD_MAPPERS, awsCarveType, applyAwsMapper, applyAwsFold } from "./aws-resources";
import { TIER_MAP, FOLDS_INTO, IDENTITY_ATTR, canBridge, canCarveEmit, carveEmitTypes } from "./tier-map";
import { canAdoptFromState } from "./adopt-state";

describe("AWS carve-out table", () => {
  test("advise and emit cover exactly the same AWS types (no cliff)", () => {
    // Every AWS type the advisor ranks (tier map) must be emittable, and vice
    // versa. Non-AWS entries (kubernetes_manifest) are excluded.
    const tierAws = Object.keys(TIER_MAP).filter((t) => t.startsWith("aws_")).sort();
    const emitAws = AWS_CARVE_TYPES.map((t) => t.tfType).sort();
    expect(tierAws).toEqual(emitAws);
    for (const t of emitAws) expect(canAdoptFromState(t)).toBe(true);
  });

  test("the emit gate is narrower than the tier map, which also ranks k8s (#2015)", () => {
    // `carve advise` bands kubernetes types; emit has no path for them, so the
    // gate both emit paths share must refuse them.
    expect(TIER_MAP.kubernetes_config_map).toBeDefined();
    expect(canCarveEmit("kubernetes_config_map")).toBe(false);
    expect(canCarveEmit("kubernetes_manifest")).toBe(false);
    expect(canCarveEmit("random_pet")).toBe(false);
    expect(canCarveEmit("aws_s3_bucket")).toBe(true);
    expect(carveEmitTypes()).toEqual(AWS_CARVE_TYPES.map((t) => t.tfType).sort());
    // State adoption and live emit gate on the same table.
    for (const t of carveEmitTypes()) expect(canAdoptFromState(t)).toBe(true);
  });

  test("canBridge rejects a dotted identity attribute (#2015)", () => {
    // A data source body is flat `attr = value`; a dotted path is not HCL.
    expect(IDENTITY_ATTR.kubernetes_manifest).toContain(".");
    expect(canBridge("kubernetes_manifest")).toBe(false);
    expect(canBridge("aws_s3_bucket")).toBe(true);
    // No identity entry at all is fine — the bridge writes a TODO comment.
    expect(canBridge("random_pet")).toBe(true);
    for (const t of AWS_CARVE_TYPES) expect(canBridge(t.tfType)).toBe(true);
  });

  test("covers the common carve targets across families", () => {
    const types = new Set(AWS_CARVE_TYPES.map((t) => t.tfType));
    for (const t of [
      "aws_s3_bucket", "aws_iam_role", "aws_iam_policy", "aws_dynamodb_table",
      "aws_lambda_function", "aws_sns_topic", "aws_sqs_queue", "aws_kms_key",
      "aws_secretsmanager_secret", "aws_ssm_parameter", "aws_ecr_repository",
      "aws_vpc", "aws_subnet", "aws_security_group", "aws_route53_zone",
      "aws_cloudwatch_log_group",
      // #998 coverage expansion: streaming, EKS, Lambda periphery, networking
      // periphery, audit, DB groups/clusters, API stages, identity, EFS periphery.
      "aws_kinesis_stream", "aws_eks_cluster", "aws_eks_node_group",
      "aws_lambda_permission", "aws_lambda_event_source_mapping",
      "aws_vpc_endpoint", "aws_route", "aws_route_table_association",
      "aws_flow_log", "aws_cloudtrail", "aws_cloudwatch_dashboard",
      "aws_rds_cluster", "aws_db_parameter_group", "aws_elasticache_subnet_group",
      "aws_lb_listener_rule", "aws_api_gateway_stage", "aws_apigatewayv2_stage",
      "aws_cognito_user_pool", "aws_appautoscaling_target",
      "aws_efs_mount_target", "aws_efs_access_point",
      "aws_sqs_queue_policy", "aws_sns_topic_policy",
    ]) {
      expect(types.has(t)).toBe(true);
    }
    expect(AWS_CARVE_TYPES.length).toBeGreaterThanOrEqual(60);
  });

  test("constructors are non-empty and consistent per native type", () => {
    // A constructor may be shared by TF aliases for the same native resource
    // (e.g. aws_lb and aws_alb both → LoadBalancer), but a given native type
    // must always map to the same constructor.
    const byNative = new Map<string, string>();
    for (const t of AWS_CARVE_TYPES) {
      expect(t.ctor.length).toBeGreaterThan(0);
      const seen = byNative.get(t.nativeType);
      if (seen) expect(t.ctor).toBe(seen);
      else byNative.set(t.nativeType, t.ctor);
    }
  });
});

describe("applyAwsMapper", () => {
  test("renames fields to CloudFormation props and reshapes tags", () => {
    const { props, mappedKeys } = applyAwsMapper(awsCarveType("aws_s3_bucket")!, {
      id: "b", bucket: "my-bucket", tags: { Env: "prod" }, force_destroy: false,
    });
    expect(props).toEqual({ BucketName: "my-bucket", Tags: [{ Key: "Env", Value: "prod" }] });
    expect(mappedKeys).toContain("bucket");
    expect(mappedKeys).toContain("tags");
    expect(mappedKeys).not.toContain("force_destroy"); // stays unmapped
  });

  test("parses a JSON-string policy into an object", () => {
    const { props } = applyAwsMapper(awsCarveType("aws_iam_role")!, {
      name: "r",
      assume_role_policy: '{"Version":"2012-10-17","Statement":[]}',
      managed_policy_arns: ["arn:aws:iam::aws:policy/X"],
    });
    expect(props.RoleName).toBe("r");
    expect(props.AssumeRolePolicyDocument).toEqual({ Version: "2012-10-17", Statement: [] });
    expect(props.ManagedPolicyArns).toEqual(["arn:aws:iam::aws:policy/X"]);
  });

  test("wraps an instance-profile role into a list", () => {
    const { props } = applyAwsMapper(awsCarveType("aws_iam_instance_profile")!, { name: "p", role: "my-role" });
    expect(props).toEqual({ InstanceProfileName: "p", Roles: ["my-role"] });
  });

  test("a malformed JSON policy is preserved as a string, not dropped", () => {
    const { props } = applyAwsMapper(awsCarveType("aws_iam_policy")!, { name: "p", policy: "not json {" });
    expect(props.PolicyDocument).toBe("not json {");
  });

  test("omits absent attributes", () => {
    const { props } = applyAwsMapper(awsCarveType("aws_subnet")!, { vpc_id: "vpc-1", cidr_block: "10.0.1.0/24" });
    expect(props).toEqual({ VpcId: "vpc-1", CidrBlock: "10.0.1.0/24" });
    expect(props).not.toHaveProperty("AvailabilityZone");
  });

  test("wraps a queue policy's queue_url and parses its policy document", () => {
    const { props } = applyAwsMapper(awsCarveType("aws_sqs_queue_policy")!, {
      queue_url: "https://sqs.us-east-1.amazonaws.com/1/q",
      policy: '{"Version":"2012-10-17","Statement":[]}',
    });
    expect(props.Queues).toEqual(["https://sqs.us-east-1.amazonaws.com/1/q"]);
    expect(props.PolicyDocument).toEqual({ Version: "2012-10-17", Statement: [] });
  });
});

describe("folded sub-resource mappers (#1637)", () => {
  test("every fold mapper is for a type that actually folds", () => {
    for (const tfType of Object.keys(AWS_FOLD_MAPPERS)) {
      expect(FOLDS_INTO[tfType]).toBeDefined();
    }
  });

  test("versioning becomes the parent's VersioningConfiguration", () => {
    const fold = applyAwsFold("aws_s3_bucket_versioning", {
      id: "my-bucket",
      bucket: "my-bucket",
      versioning_configuration: [{ status: "Enabled", mfa_delete: "" }],
      expected_bucket_owner: "",
    })!;
    expect(fold.props).toEqual({ VersioningConfiguration: { Status: "Enabled" } });
    // The parent link is not content; the leftover attribute still reports.
    expect(fold.unmapped).toEqual({ expected_bucket_owner: "" });
  });

  test("a status CloudFormation cannot spell maps nothing and consumes nothing", () => {
    const fold = applyAwsFold("aws_s3_bucket_versioning", {
      bucket: "b",
      versioning_configuration: [{ status: "Disabled" }],
    })!;
    expect(fold.props).toEqual({});
    expect(fold.unmapped).toEqual({ versioning_configuration: [{ status: "Disabled" }] });
  });

  test("the public access block becomes the parent's PublicAccessBlockConfiguration", () => {
    const fold = applyAwsFold("aws_s3_bucket_public_access_block", {
      id: "my-bucket",
      bucket: "my-bucket",
      block_public_acls: true,
      block_public_policy: true,
      ignore_public_acls: true,
      restrict_public_buckets: false,
    })!;
    expect(fold.props).toEqual({
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: false,
      },
    });
    expect(fold.unmapped).toEqual({});
  });

  test("the SSE sub-resource becomes BucketEncryption, KMS key included", () => {
    const fold = applyAwsFold("aws_s3_bucket_server_side_encryption_configuration", {
      bucket: "my-bucket",
      rule: [
        {
          apply_server_side_encryption_by_default: [{ sse_algorithm: "aws:kms", kms_master_key_id: "arn:aws:kms:k" }],
          bucket_key_enabled: true,
        },
      ],
    })!;
    expect(fold.props).toEqual({
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms", KMSMasterKeyID: "arn:aws:kms:k" }, BucketKeyEnabled: true },
        ],
      },
    });
  });

  test("a sub-resource type with no mapping yet returns null (the caller reports it)", () => {
    expect(applyAwsFold("aws_s3_bucket_policy", { policy: "{}" })).toBeNull();
  });

  test("the bucket's own in-state versioning and SSE blocks map too", () => {
    const { props, mappedKeys } = applyAwsMapper(awsCarveType("aws_s3_bucket")!, {
      bucket: "my-bucket",
      versioning: [{ enabled: true, mfa_delete: false }],
      server_side_encryption_configuration: [
        { rule: [{ apply_server_side_encryption_by_default: [{ sse_algorithm: "AES256", kms_master_key_id: "" }], bucket_key_enabled: false }] },
      ],
    });
    expect(props.VersioningConfiguration).toEqual({ Status: "Enabled" });
    expect(props.BucketEncryption).toEqual({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" }, BucketKeyEnabled: false },
      ],
    });
    expect(mappedKeys).toContain("versioning");
  });

  test("an unversioned bucket's empty blocks map nothing and stay reported", () => {
    const { props, mappedKeys } = applyAwsMapper(awsCarveType("aws_s3_bucket")!, {
      bucket: "my-bucket",
      versioning: [{ enabled: false, mfa_delete: false }],
      server_side_encryption_configuration: [],
    });
    expect(props).not.toHaveProperty("VersioningConfiguration");
    expect(props).not.toHaveProperty("BucketEncryption");
    expect(mappedKeys).not.toContain("versioning");
    expect(mappedKeys).not.toContain("server_side_encryption_configuration");
  });
});

describe("tier + identity coverage maps (#998)", () => {
  test("kubernetes provider types rank, with _v1 aliases sharing the entry", () => {
    expect(TIER_MAP.kubernetes_manifest).toEqual({ tier: 1, mapsTo: "k8s:manifest" });
    for (const t of ["kubernetes_deployment", "kubernetes_config_map", "kubernetes_service", "kubernetes_namespace"]) {
      expect(TIER_MAP[t]).toMatchObject({ tier: 2 });
      expect(TIER_MAP[`${t}_v1`]).toEqual(TIER_MAP[t]);
    }
    expect(TIER_MAP.kubernetes_horizontal_pod_autoscaler_v2).toEqual(TIER_MAP.kubernetes_horizontal_pod_autoscaler);
  });

  test("S3 and ECR sub-resources fold into their parent", () => {
    for (const t of [
      "aws_s3_bucket_website_configuration", "aws_s3_bucket_cors_configuration", "aws_s3_bucket_logging",
      "aws_s3_bucket_ownership_controls", "aws_s3_bucket_notification",
    ]) {
      expect(FOLDS_INTO[t]).toBe("aws_s3_bucket");
    }
    expect(FOLDS_INTO.aws_ecr_lifecycle_policy).toBe("aws_ecr_repository");
    expect(FOLDS_INTO.aws_ecr_repository_policy).toBe("aws_ecr_repository");
  });

  test("identity attrs cover the expanded types, including a dotted non-AWS path", () => {
    expect(IDENTITY_ATTR.aws_elasticache_cluster).toBe("cluster_id");
    expect(IDENTITY_ATTR.aws_ecs_task_definition).toBe("family");
    expect(IDENTITY_ATTR.aws_route53_record).toBe("name");
    expect(IDENTITY_ATTR.aws_eks_node_group).toBe("node_group_name");
    expect(IDENTITY_ATTR.kubernetes_manifest).toBe("manifest.metadata.name");
  });
});
