import { Sub, AWS, Ref, GetAtt, If, Join, Select, Split, Base64, GetAZs } from "@intentius/chant-lexicon-aws";

// Sub — string substitution (tagged template literal)
export const bucketName = Sub`${AWS.StackName}-data`;
export const arn = Sub`arn:aws:s3:::${AWS.AccountId}:${AWS.Region}:*`;

// Ref — resource and parameter references
export const envRef = Ref("Environment");

// GetAtt — resource attributes
export const bucketArn = GetAtt("DataBucket", "Arn");

// If — conditional values
export const conditionalName = If("IsProduction", "prod-data", "dev-data");

// Join — join values with delimiter
export const joined = Join("-", ["prefix", AWS.StackName, "suffix"]);

// Select + Split — select by index from split string
export const first = Select(0, Split(",", "a,b,c"));

// Split — split string by delimiter
export const parts = Split(",", "a,b,c");

// Base64 — encode to Base64
export const userData = Base64(Sub`#!/bin/bash
echo "Stack: ${AWS.StackName}"
yum update -y
`);

// GetAZs — availability zones for a region
export const azs = GetAZs();
