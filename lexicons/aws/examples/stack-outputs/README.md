# stack-outputs

Declaring a CloudFormation `Outputs` section, all three ways chant supports.

`src/main.ts` declares the resources. `src/outputs.ts` exports the outputs:

- `output(ref, "Name")` — a resource attribute, under a logical id you choose.
- `output(intrinsic, "Name")` — a value computed from one (here a `Sub`).
- `stackOutput(ref, { description })` — the cross-stack primitive, for a
  consumer stack to import. The logical id is the export name.

```bash
npm run build
```

```json
{
  "Outputs": {
    "VpcId": { "Value": { "Fn::GetAtt": ["networkVpc", "VpcId"] } },
    "VpcArn": { "Value": { "Fn::Sub": "arn:${AWS::Partition}:ec2:..." } },
    "PublicSubnetId": { "Value": { "Fn::GetAtt": ["networkPublicSubnet1", "SubnetId"] } }
  }
}
```

Outputs are declared in their own file so they reference the resources across
a module boundary — the shape most projects use, and the one `chant build
--fold` has to get right (chant#1112).
