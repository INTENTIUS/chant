/**
 * Fallback resource definitions for priority types missing from the schema zip.
 * Acts as a safety net — if the schema zip already contains the resource,
 * the fallback is not used.
 */

import type { SchemaParseResult } from "../spec/parse";

export function fallbackResources(): SchemaParseResult[] {
  return [fallbackLogGroup()];
}

function fallbackLogGroup(): SchemaParseResult {
  return {
    resource: {
      typeName: "AWS::Logs::LogGroup",
      properties: [
        { name: "LogGroupName", tsType: "string", required: false, constraints: {} },
        { name: "RetentionInDays", tsType: "number", required: false, constraints: {} },
        { name: "KmsKeyId", tsType: "string", required: false, constraints: {} },
        { name: "DataProtectionPolicy", tsType: "any", required: false, constraints: {} },
        { name: "Tags", tsType: "Tag[]", required: false, constraints: {} },
        { name: "LogGroupClass", tsType: "string", required: false, constraints: {} },
      ],
      attributes: [{ name: "Arn", tsType: "string" }],
      createOnly: [],
      writeOnly: [],
      primaryIdentifier: [],
    },
    propertyTypes: [],
    enums: [],
  };
}
