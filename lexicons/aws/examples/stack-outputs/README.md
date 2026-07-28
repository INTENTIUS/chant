# stack-outputs

Declaring a CloudFormation `Outputs` section, all five ways chant supports.

`src/main.ts` declares the resources (and a `Parameter`). `src/outputs.ts`
exports the outputs:

- `output(ref, "Name")` — a resource attribute, under a logical id you choose.
- `output(intrinsic, "Name")` — a value computed from one (here a `Sub`).
- `stackOutput(ref, { description })` — the cross-stack primitive, for a
  consumer stack to import. The logical id is the export name.
- `output(literal, "Name")` — an already-resolved value (a real
  string/number/boolean the caller computed, not a reference to anything).
  Emitted as a plain `Value` (chant#1121).
- `stackOutput(Ref(parameter), { exportName })` — the cross-stack primitive
  wrapping a `Ref` to a `Parameter` rather than to a resource attribute. A
  CloudFormation Parameter carries no attributes at all, so this is the shape
  whose only nested entity is the Parameter Declarable itself, never an
  AttrRef (chant#1152).

```bash
npm run build
```

```json
{
  "Outputs": {
    "VpcId": { "Value": { "Fn::GetAtt": ["networkVpc", "VpcId"] } },
    "VpcArn": { "Value": { "Fn::Sub": "arn:${AWS::Partition}:ec2:..." } },
    "PublicSubnetId": { "Value": { "Fn::GetAtt": ["networkPublicSubnet1", "SubnetId"] } },
    "ApiVersion": { "Value": "v1" },
    "EnvironmentName": { "Value": { "Ref": "environment" }, "Export": { "Name": "EnvironmentName" } }
  }
}
```

Outputs are declared in their own file so they reference the resources across
a module boundary — the shape most projects use, and the one `chant build
--fold` has to get right (chant#1112).
