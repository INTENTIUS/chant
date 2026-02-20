import * as _ from "./_";

// --- Sub: string substitution ---
export const bucketName = _.Sub`${_.AWS.StackName}-data`;
export const arn = _.Sub`arn:aws:s3:::${_.AWS.AccountId}:${_.AWS.Region}:*`;

// --- Ref: resource and parameter references ---
// chant-disable-next-line COR003
export const envRef = _.Ref("Environment");

// --- If: conditional values ---
export const value = _.If("IsProduction", "prod-value", "dev-value");

// --- Join: join values ---
export const joined = _.Join("-", ["prefix", _.AWS.StackName, "suffix"]);

// --- Select + Split ---
export const first = _.Select(0, _.Split(",", "a,b,c"));

// --- Split: split string ---
export const parts = _.Split(",", "a,b,c");

// --- Base64: encode to Base64 ---
export const userData = _.Base64(_.Sub`#!/bin/bash
echo "Stack: ${_.AWS.StackName}"
yum update -y
`);
