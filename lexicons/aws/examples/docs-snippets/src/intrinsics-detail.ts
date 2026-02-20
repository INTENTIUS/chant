import { Sub, AWS, Ref, If, Join, Select, Split, Base64 } from "@intentius/chant-lexicon-aws";

// --- Sub: string substitution ---
export const bucketName = Sub`${AWS.StackName}-data`;
export const arn = Sub`arn:aws:s3:::${AWS.AccountId}:${AWS.Region}:*`;

// --- Ref: resource and parameter references ---
// chant-disable-next-line COR003
export const envRef = Ref("Environment");

// --- If: conditional values ---
export const value = If("IsProduction", "prod-value", "dev-value");

// --- Join: join values ---
export const joined = Join("-", ["prefix", AWS.StackName, "suffix"]);

// --- Select + Split ---
export const first = Select(0, Split(",", "a,b,c"));

// --- Split: split string ---
export const parts = Split(",", "a,b,c");

// --- Base64: encode to Base64 ---
export const userData = Base64(Sub`#!/bin/bash
echo "Stack: ${AWS.StackName}"
yum update -y
`);
