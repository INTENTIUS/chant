/**
 * AWS-specific naming configuration for the core NamingStrategy.
 *
 * The algorithm lives in core; only the data tables and helper functions
 * for extracting names from AWS CloudFormation types are defined here.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NamingStrategy as CoreNamingStrategy,
  reservedNamesFromSnapshot,
  type NamingConfig,
  type NamingInput,
} from "@intentius/chant/codegen/naming";

export { propertyTypeName, extractDefName } from "@intentius/chant/codegen/naming";

import type { SchemaParseResult } from "../spec/parse";
import { cfnShortName, cfnServiceName } from "../spec/parse";

/**
 * Fixed TypeScript class names for backward compatibility.
 */
const priorityNames: Record<string, string> = {
  "AWS::S3::Bucket": "Bucket",
  "AWS::Lambda::Function": "Function",
  "AWS::IAM::Role": "Role",
  "AWS::IAM::Policy": "Policy",
  "AWS::DynamoDB::Table": "Table",
  "AWS::SQS::Queue": "Queue",
  "AWS::SNS::Topic": "Topic",
  "AWS::EC2::Instance": "Instance",
  "AWS::EC2::SecurityGroup": "SecurityGroup",
  "AWS::EC2::VPC": "Vpc",
  "AWS::EC2::Subnet": "Subnet",
  "AWS::CloudFormation::Stack": "Stack",
  "AWS::CloudWatch::Alarm": "Alarm",
  "AWS::Events::Rule": "EventRule",
  "AWS::Logs::LogGroup": "LogGroup",
  "AWS::ApiGateway::RestApi": "RestApi",
  "AWS::ApiGatewayV2::Api": "HttpApi",
  "AWS::ECS::Cluster": "EcsCluster",
  "AWS::ECS::Service": "EcsService",
  "AWS::ECS::TaskDefinition": "TaskDefinition",
  "AWS::ElasticLoadBalancingV2::LoadBalancer": "LoadBalancer",
  "AWS::ElasticLoadBalancingV2::TargetGroup": "TargetGroup",
  "AWS::ElasticLoadBalancingV2::Listener": "Listener",
  "AWS::RDS::DBInstance": "DbInstance",
  "AWS::RDS::DBCluster": "DbCluster",
  "AWS::StepFunctions::StateMachine": "StateMachine",
  "AWS::KMS::Key": "KmsKey",
  "AWS::SecretsManager::Secret": "Secret",
  "AWS::SSM::Parameter": "SsmParameter",
  "AWS::Lambda::Permission": "Permission",
  "AWS::Lambda::LayerVersion": "LayerVersion",
  "AWS::IAM::ManagedPolicy": "ManagedPolicy",
  "AWS::IAM::InstanceProfile": "InstanceProfile",
};

/**
 * Additional TypeScript names beyond the primary priority name.
 */
const priorityAliases: Record<string, string[]> = {
  "AWS::IAM::Policy": ["IamPolicy"],
};

/**
 * Property type aliases that must always be emitted for backward compat.
 */
const priorityPropertyAliases: Record<string, Record<string, string>> = {
  "AWS::S3::Bucket": {
    ServerSideEncryptionByDefault: "ServerSideEncryptionByDefault",
    ServerSideEncryptionRule: "ServerSideEncryptionRule",
    BucketEncryption: "BucketEncryption",
    VersioningConfiguration: "VersioningConfiguration",
    PublicAccessBlockConfiguration: "PublicAccessBlockConfiguration",
    LoggingConfiguration: "LoggingConfiguration",
  },
  "AWS::Lambda::Function": {
    Code: "Code",
    Environment: "Environment",
  },
};

/**
 * Service name abbreviations for collision-resolved names.
 */
const serviceAbbreviations: Record<string, string> = {
  ElasticLoadBalancingV2: "Elbv2",
  CloudFormation: "Cfn",
  CloudWatch: "Cw",
  ApiGateway: "Apigw",
  ApiGatewayV2: "Apigwv2",
  SecretsManager: "Sm",
  StepFunctions: "Sfn",
  CertificateManager: "Acm",
  ElasticLoadBalancing: "Elb",
  CloudFront: "Cf",
  ElastiCache: "Ec",
};

const awsNamingConfig: NamingConfig = {
  priorityNames,
  priorityAliases,
  priorityPropertyAliases,
  serviceAbbreviations,
  shortName: cfnShortName,
  serviceName: cfnServiceName,
};

/**
 * AWS-specific NamingStrategy — wraps the core algorithm with AWS data tables.
 */
export class NamingStrategy extends CoreNamingStrategy {
  /**
   * @param reservedNames chant #1459 — spec type → already-published TS name,
   *   normally {@link publishedNames}. Passed in rather than read here on
   *   purpose: a fixture-driven codegen run (`./snapshot.test.ts`) must not
   *   inherit the repo's real 1600-entry surface, or its output would depend on
   *   whatever the lexicon last shipped instead of on its fixtures.
   */
  constructor(results: SchemaParseResult[], reservedNames: Record<string, string> = {}) {
    const inputs: NamingInput[] = results.map((r) => ({
      typeName: r.resource.typeName,
      propertyTypes: r.propertyTypes,
    }));
    super(inputs, { ...awsNamingConfig, reservedNames });
  }
}

/**
 * Reserved names from the committed surface snapshot, or none when it cannot
 * be read.
 *
 * Defensive: codegen must still run for a lexicon with no snapshot yet, and a
 * missing or malformed snapshot should degrade to the previous naming
 * behaviour rather than fail generation outright. `surface-diff` makes the
 * consequence visible either way.
 */
export function publishedNames(): Record<string, string> {
  try {
    const snapshotPath = join(import.meta.dirname, "..", "..", "surface.snapshot.json");
    if (!existsSync(snapshotPath)) return {};
    return reservedNamesFromSnapshot(JSON.parse(readFileSync(snapshotPath, "utf-8")));
  } catch {
    return {};
  }
}
