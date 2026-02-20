import * as _ from "./_";

// Sub — string substitution (tagged template literal)
export const bucketName = _.Sub`${_.AWS.StackName}-data`;
export const arn = _.Sub`arn:aws:s3:::${_.AWS.AccountId}:${_.AWS.Region}:*`;

// Ref — resource and parameter references
export const envRef = _.Ref("Environment");

// GetAtt — resource attributes
export const bucketArn = _.GetAtt("DataBucket", "Arn");

// If — conditional values
export const conditionalName = _.If("IsProduction", "prod-data", "dev-data");

// Join — join values with delimiter
export const joined = _.Join("-", ["prefix", _.AWS.StackName, "suffix"]);

// Select + Split — select by index from split string
export const first = _.Select(0, _.Split(",", "a,b,c"));

// Split — split string by delimiter
export const parts = _.Split(",", "a,b,c");

// Base64 — encode to Base64
export const userData = _.Base64(_.Sub`#!/bin/bash
echo "Stack: ${_.AWS.StackName}"
yum update -y
`);

// GetAZs — availability zones for a region
export const azs = _.GetAZs();
