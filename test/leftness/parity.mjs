// Matched-pair parity check (chant #1084 AC: "the same infrastructure is expressed in
// both tools"). Compares the two synthesized templates by resource type. The pair is
// functionally identical; exactly two style-of-expression deltas are expected and
// documented, and anything else fails the run:
//
//   - CDK emits a separate AWS::IAM::Policy for grantReadWriteData; the chant estate
//     inlines the same statements in the role's Policies.
//   - CDK emits one AWS::Lambda::Permission per route (4); the chant estate grants one
//     wildcard-source permission for the API.
//
// Both are the same authorization surface written differently, and both deltas make the
// CDK template LARGER — the comparison never flatters chant.

import { readFileSync, writeFileSync } from "node:fs";

const count = (t) => {
  const c = {};
  for (const r of Object.values(t.Resources ?? {})) c[r.Type] = (c[r.Type] ?? 0) + 1;
  return c;
};

const chant = count(JSON.parse(readFileSync("chant-app/out/template.json", "utf8")));
const cdk = count(JSON.parse(readFileSync("cdk-app/cdk.out/leftness-items.template.json", "utf8")));

const EXPECTED_DELTAS = { "AWS::IAM::Policy": 1, "AWS::Lambda::Permission": 3 }; // cdk minus chant

const problems = [];
for (const type of new Set([...Object.keys(chant), ...Object.keys(cdk)])) {
  const delta = (cdk[type] ?? 0) - (chant[type] ?? 0);
  if (delta !== (EXPECTED_DELTAS[type] ?? 0)) {
    problems.push(`${type}: cdk=${cdk[type] ?? 0} chant=${chant[type] ?? 0} (unexpected delta ${delta})`);
  }
}

writeFileSync("results/parity.json", JSON.stringify({ chant, cdk, expectedDeltas: EXPECTED_DELTAS, problems }, null, 2) + "\n");

if (problems.length) {
  console.error("FAIL: the pair drifted apart:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`   parity holds: ${Object.values(chant).reduce((a, b) => a + b, 0)} chant resources ↔ ${Object.values(cdk).reduce((a, b) => a + b, 0)} cdk resources, deltas are the two documented expansion styles`);
