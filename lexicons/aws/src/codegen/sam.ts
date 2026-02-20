/**
 * SAM (Serverless Application Model) resource definitions.
 *
 * Hand-authored since no machine-readable SAM spec exists.
 * 9 resources matching the Go implementation.
 */

import type { SchemaParseResult, ParsedProperty, ParsedAttribute, ParsedPropertyType } from "../spec/parse";

export function samResources(): SchemaParseResult[] {
  return [
    samFunction(),
    samApi(),
    samHttpApi(),
    samSimpleTable(),
    samLayerVersion(),
    samStateMachine(),
    samApplication(),
    samConnector(),
    samGraphQLApi(),
  ];
}

function samFunction(): SchemaParseResult {
  return {
    resource: {
      typeName: "AWS::Serverless::Function",
      properties: [
        { name: "Handler", tsType: "string", required: true, constraints: {} },
        { name: "Runtime", tsType: "string", required: true, constraints: {} },
        { name: "CodeUri", tsType: "any", required: true, constraints: {} },
        { name: "FunctionName", tsType: "string", required: false, constraints: {} },
        { name: "Description", tsType: "string", required: false, constraints: {} },
        { name: "MemorySize", tsType: "number", required: false, constraints: {} },
        { name: "Timeout", tsType: "number", required: false, constraints: {} },
        { name: "Role", tsType: "string", required: false, constraints: {} },
        { name: "Policies", tsType: "any[]", required: false, constraints: {} },
        { name: "Environment", tsType: "Function_Environment", required: false, constraints: {} },
        { name: "Events", tsType: "Record<string, any>", required: false, constraints: {} },
        { name: "VpcConfig", tsType: "Function_VpcConfig", required: false, constraints: {} },
        { name: "Architectures", tsType: "string[]", required: false, constraints: {} },
        { name: "Layers", tsType: "string[]", required: false, constraints: {} },
        { name: "Tracing", tsType: "string", required: false, constraints: {} },
        { name: "Tags", tsType: "Record<string, any>", required: false, constraints: {} },
        { name: "DeadLetterQueue", tsType: "Function_DeadLetterQueue", required: false, constraints: {} },
        { name: "DeploymentPreference", tsType: "Function_DeploymentPreference", required: false, constraints: {} },
        { name: "ReservedConcurrentExecutions", tsType: "number", required: false, constraints: {} },
        { name: "AutoPublishAlias", tsType: "string", required: false, constraints: {} },
        { name: "PackageType", tsType: "string", required: false, constraints: {} },
        { name: "ImageUri", tsType: "string", required: false, constraints: {} },
        { name: "ImageConfig", tsType: "any", required: false, constraints: {} },
        { name: "EphemeralStorage", tsType: "any", required: false, constraints: {} },
        { name: "SnapStart", tsType: "any", required: false, constraints: {} },
        { name: "FunctionUrlConfig", tsType: "any", required: false, constraints: {} },
        { name: "InlineCode", tsType: "string", required: false, constraints: {} },
      ],
      attributes: [{ name: "Arn", tsType: "string" }],
      createOnly: [],
      writeOnly: [],
      primaryIdentifier: [],
    },
    propertyTypes: [
      {
        name: "Function_Environment",
        specType: "Environment",
        properties: [
          { name: "Variables", tsType: "Record<string, any>", required: false, constraints: {} },
        ],
      },
      {
        name: "Function_VpcConfig",
        specType: "VpcConfig",
        properties: [
          { name: "SecurityGroupIds", tsType: "string[]", required: true, constraints: {} },
          { name: "SubnetIds", tsType: "string[]", required: true, constraints: {} },
        ],
      },
      {
        name: "Function_DeadLetterQueue",
        specType: "DeadLetterQueue",
        properties: [
          { name: "Type", tsType: "string", required: true, constraints: {} },
          { name: "TargetArn", tsType: "string", required: true, constraints: {} },
        ],
      },
      {
        name: "Function_DeploymentPreference",
        specType: "DeploymentPreference",
        properties: [
          { name: "Type", tsType: "string", required: true, constraints: {} },
          { name: "Enabled", tsType: "boolean", required: false, constraints: {} },
          { name: "Alarms", tsType: "string[]", required: false, constraints: {} },
          { name: "Hooks", tsType: "any", required: false, constraints: {} },
        ],
      },
      {
        name: "Function_EventSource",
        specType: "EventSource",
        properties: [
          { name: "Type", tsType: "string", required: true, constraints: {} },
          { name: "Properties", tsType: "any", required: false, constraints: {} },
        ],
      },
      {
        name: "Function_S3Location",
        specType: "S3Location",
        properties: [
          { name: "Bucket", tsType: "string", required: true, constraints: {} },
          { name: "Key", tsType: "string", required: true, constraints: {} },
          { name: "Version", tsType: "string", required: false, constraints: {} },
        ],
      },
    ],
    enums: [],
  };
}

function samApi(): SchemaParseResult {
  return {
    resource: {
      typeName: "AWS::Serverless::Api",
      properties: [
        { name: "StageName", tsType: "string", required: true, constraints: {} },
        { name: "DefinitionBody", tsType: "any", required: false, constraints: {} },
        { name: "DefinitionUri", tsType: "any", required: false, constraints: {} },
        { name: "Name", tsType: "string", required: false, constraints: {} },
        { name: "Auth", tsType: "Api_Auth", required: false, constraints: {} },
        { name: "Cors", tsType: "any", required: false, constraints: {} },
        { name: "EndpointConfiguration", tsType: "string", required: false, constraints: {} },
        { name: "TracingEnabled", tsType: "boolean", required: false, constraints: {} },
        { name: "CacheClusterEnabled", tsType: "boolean", required: false, constraints: {} },
        { name: "CacheClusterSize", tsType: "string", required: false, constraints: {} },
        { name: "Variables", tsType: "Record<string, any>", required: false, constraints: {} },
        { name: "Tags", tsType: "Record<string, any>", required: false, constraints: {} },
        { name: "AccessLogSetting", tsType: "any", required: false, constraints: {} },
        { name: "CanarySetting", tsType: "any", required: false, constraints: {} },
        { name: "MethodSettings", tsType: "any[]", required: false, constraints: {} },
        { name: "BinaryMediaTypes", tsType: "string[]", required: false, constraints: {} },
        { name: "MinimumCompressionSize", tsType: "number", required: false, constraints: {} },
        { name: "OpenApiVersion", tsType: "string", required: false, constraints: {} },
        { name: "GatewayResponses", tsType: "Record<string, any>", required: false, constraints: {} },
      ],
      attributes: [{ name: "RootResourceId", tsType: "string" }],
      createOnly: [],
      writeOnly: [],
      primaryIdentifier: [],
    },
    propertyTypes: [
      {
        name: "Api_Auth",
        specType: "Auth",
        properties: [
          { name: "DefaultAuthorizer", tsType: "string", required: false, constraints: {} },
          { name: "Authorizers", tsType: "Record<string, any>", required: false, constraints: {} },
          { name: "ApiKeyRequired", tsType: "boolean", required: false, constraints: {} },
          { name: "UsagePlan", tsType: "any", required: false, constraints: {} },
        ],
      },
      {
        name: "Api_CorsConfiguration",
        specType: "CorsConfiguration",
        properties: [
          { name: "AllowOrigin", tsType: "string", required: true, constraints: {} },
          { name: "AllowHeaders", tsType: "string", required: false, constraints: {} },
          { name: "AllowMethods", tsType: "string", required: false, constraints: {} },
          { name: "AllowCredentials", tsType: "boolean", required: false, constraints: {} },
          { name: "MaxAge", tsType: "number", required: false, constraints: {} },
        ],
      },
    ],
    enums: [],
  };
}

function samHttpApi(): SchemaParseResult {
  return {
    resource: {
      typeName: "AWS::Serverless::HttpApi",
      properties: [
        { name: "StageName", tsType: "string", required: false, constraints: {} },
        { name: "DefinitionBody", tsType: "any", required: false, constraints: {} },
        { name: "DefinitionUri", tsType: "any", required: false, constraints: {} },
        { name: "Name", tsType: "string", required: false, constraints: {} },
        { name: "CorsConfiguration", tsType: "any", required: false, constraints: {} },
        { name: "Auth", tsType: "any", required: false, constraints: {} },
        { name: "AccessLogSettings", tsType: "any", required: false, constraints: {} },
        { name: "DefaultRouteSettings", tsType: "any", required: false, constraints: {} },
        { name: "RouteSettings", tsType: "Record<string, any>", required: false, constraints: {} },
        { name: "StageVariables", tsType: "Record<string, any>", required: false, constraints: {} },
        { name: "Tags", tsType: "Record<string, any>", required: false, constraints: {} },
        { name: "FailOnWarnings", tsType: "boolean", required: false, constraints: {} },
        { name: "DisableExecuteApiEndpoint", tsType: "boolean", required: false, constraints: {} },
      ],
      attributes: [{ name: "ApiEndpoint", tsType: "string" }],
      createOnly: [],
      writeOnly: [],
      primaryIdentifier: [],
    },
    propertyTypes: [
      {
        name: "HttpApi_CorsConfiguration",
        specType: "CorsConfiguration",
        properties: [
          { name: "AllowOrigins", tsType: "string[]", required: false, constraints: {} },
          { name: "AllowHeaders", tsType: "string[]", required: false, constraints: {} },
          { name: "AllowMethods", tsType: "string[]", required: false, constraints: {} },
          { name: "AllowCredentials", tsType: "boolean", required: false, constraints: {} },
          { name: "ExposeHeaders", tsType: "string[]", required: false, constraints: {} },
          { name: "MaxAge", tsType: "number", required: false, constraints: {} },
        ],
      },
    ],
    enums: [],
  };
}

function samSimpleTable(): SchemaParseResult {
  return {
    resource: {
      typeName: "AWS::Serverless::SimpleTable",
      properties: [
        { name: "PrimaryKey", tsType: "SimpleTable_PrimaryKey", required: false, constraints: {} },
        { name: "ProvisionedThroughput", tsType: "any", required: false, constraints: {} },
        { name: "TableName", tsType: "string", required: false, constraints: {} },
        { name: "Tags", tsType: "Record<string, any>", required: false, constraints: {} },
        { name: "SSESpecification", tsType: "any", required: false, constraints: {} },
      ],
      attributes: [],
      createOnly: [],
      writeOnly: [],
      primaryIdentifier: [],
    },
    propertyTypes: [
      {
        name: "SimpleTable_PrimaryKey",
        specType: "PrimaryKey",
        properties: [
          { name: "Name", tsType: "string", required: true, constraints: {} },
          { name: "Type", tsType: "string", required: true, constraints: {} },
        ],
      },
    ],
    enums: [],
  };
}

function samLayerVersion(): SchemaParseResult {
  return {
    resource: {
      typeName: "AWS::Serverless::LayerVersion",
      properties: [
        { name: "ContentUri", tsType: "any", required: true, constraints: {} },
        { name: "LayerName", tsType: "string", required: false, constraints: {} },
        { name: "Description", tsType: "string", required: false, constraints: {} },
        { name: "CompatibleRuntimes", tsType: "string[]", required: false, constraints: {} },
        { name: "CompatibleArchitectures", tsType: "string[]", required: false, constraints: {} },
        { name: "LicenseInfo", tsType: "string", required: false, constraints: {} },
        { name: "RetentionPolicy", tsType: "string", required: false, constraints: {} },
      ],
      attributes: [
        { name: "Arn", tsType: "string" },
        { name: "LayerArn", tsType: "string" },
      ],
      createOnly: [],
      writeOnly: [],
      primaryIdentifier: [],
    },
    propertyTypes: [],
    enums: [],
  };
}

function samStateMachine(): SchemaParseResult {
  return {
    resource: {
      typeName: "AWS::Serverless::StateMachine",
      properties: [
        { name: "Definition", tsType: "any", required: false, constraints: {} },
        { name: "DefinitionUri", tsType: "any", required: false, constraints: {} },
        { name: "DefinitionSubstitutions", tsType: "Record<string, any>", required: false, constraints: {} },
        { name: "Name", tsType: "string", required: false, constraints: {} },
        { name: "Role", tsType: "string", required: false, constraints: {} },
        { name: "Policies", tsType: "any[]", required: false, constraints: {} },
        { name: "Type", tsType: "string", required: false, constraints: {} },
        { name: "Logging", tsType: "any", required: false, constraints: {} },
        { name: "Tracing", tsType: "any", required: false, constraints: {} },
        { name: "Events", tsType: "Record<string, any>", required: false, constraints: {} },
        { name: "Tags", tsType: "Record<string, any>", required: false, constraints: {} },
        { name: "PermissionsBoundary", tsType: "string", required: false, constraints: {} },
      ],
      attributes: [
        { name: "Arn", tsType: "string" },
        { name: "Name", tsType: "string" },
      ],
      createOnly: [],
      writeOnly: [],
      primaryIdentifier: [],
    },
    propertyTypes: [
      {
        name: "StateMachine_S3Location",
        specType: "S3Location",
        properties: [
          { name: "Bucket", tsType: "string", required: true, constraints: {} },
          { name: "Key", tsType: "string", required: true, constraints: {} },
          { name: "Version", tsType: "string", required: false, constraints: {} },
        ],
      },
    ],
    enums: [],
  };
}

function samApplication(): SchemaParseResult {
  return {
    resource: {
      typeName: "AWS::Serverless::Application",
      properties: [
        { name: "Location", tsType: "any", required: true, constraints: {} },
        { name: "Parameters", tsType: "Record<string, any>", required: false, constraints: {} },
        { name: "NotificationArns", tsType: "string[]", required: false, constraints: {} },
        { name: "Tags", tsType: "Record<string, any>", required: false, constraints: {} },
        { name: "TimeoutInMinutes", tsType: "number", required: false, constraints: {} },
      ],
      attributes: [{ name: "Outputs", tsType: "any" }],
      createOnly: [],
      writeOnly: [],
      primaryIdentifier: [],
    },
    propertyTypes: [],
    enums: [],
  };
}

function samConnector(): SchemaParseResult {
  return {
    resource: {
      typeName: "AWS::Serverless::Connector",
      properties: [
        { name: "Source", tsType: "any", required: true, constraints: {} },
        { name: "Destination", tsType: "any", required: true, constraints: {} },
        { name: "Permissions", tsType: "string[]", required: true, constraints: {} },
      ],
      attributes: [],
      createOnly: [],
      writeOnly: [],
      primaryIdentifier: [],
    },
    propertyTypes: [],
    enums: [],
  };
}

function samGraphQLApi(): SchemaParseResult {
  return {
    resource: {
      typeName: "AWS::Serverless::GraphQLApi",
      properties: [
        { name: "SchemaUri", tsType: "string", required: false, constraints: {} },
        { name: "SchemaInline", tsType: "string", required: false, constraints: {} },
        { name: "Name", tsType: "string", required: false, constraints: {} },
        { name: "Auth", tsType: "any", required: true, constraints: {} },
        { name: "DataSources", tsType: "any", required: false, constraints: {} },
        { name: "Functions", tsType: "any", required: false, constraints: {} },
        { name: "Resolvers", tsType: "any", required: false, constraints: {} },
        { name: "Logging", tsType: "any", required: false, constraints: {} },
        { name: "XrayEnabled", tsType: "boolean", required: false, constraints: {} },
        { name: "Tags", tsType: "Record<string, any>", required: false, constraints: {} },
        { name: "Cache", tsType: "any", required: false, constraints: {} },
        { name: "DomainName", tsType: "any", required: false, constraints: {} },
      ],
      attributes: [
        { name: "ApiId", tsType: "string" },
        { name: "Arn", tsType: "string" },
        { name: "GraphQLUrl", tsType: "string" },
        { name: "GraphQLDns", tsType: "string" },
        { name: "RealtimeUrl", tsType: "string" },
        { name: "RealtimeDns", tsType: "string" },
      ],
      createOnly: [],
      writeOnly: [],
      primaryIdentifier: [],
    },
    propertyTypes: [],
    enums: [],
  };
}
