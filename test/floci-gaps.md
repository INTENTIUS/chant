# Floci emulator gaps found while working chant

A running log of emulator behaviour that blocks chant work, kept here so each
entry can be filed upstream (lex00/floci and the floci-io repos) later, in one
pass, with a repro that still runs. Nothing here is a chant bug. Add an entry
the moment you hit one; do not rely on remembering it.

Each entry: what was run, what came back, what it blocks, and how it was
confirmed. Keep the repro copy-pasteable — an entry nobody can re-run is an
entry that will not get filed.

Emulator under test unless an entry says otherwise:

```
docker run -d --rm -p 4599:4566 --name floci floci/floci:latest
export AWS_ENDPOINT_URL=http://localhost:4599 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
```

`/_localstack/health` reports `"original_edition":"floci-always-free"`,
`"edition":"community"`, with `cloudcontrol`, `cloudformation` and `ec2` all
`running`.

---

## 1. Cloud Control `GetResource` is not implemented

**Status:** confirmed 2026-08-01, unfiled.

```
$ aws cloudcontrol get-resource --type-name AWS::S3::Bucket --identifier <bucket>
An error occurred (UnsupportedOperation) when calling the GetResource operation:
Operation GetResource is not supported.
```

Same answer on the wire, so it is the service and not the CLI:

```
$ curl -s -X POST http://localhost:4599/ \
    -H 'X-Amz-Target: CloudApiService.GetResource' \
    -H 'Content-Type: application/x-amz-json-1.0' \
    -d '{"TypeName":"AWS::S3::Bucket","Identifier":"<bucket>"}'
{"__type":"UnsupportedOperation","message":"Operation GetResource is not supported."}
```

`ListResources` on the same service works, so `cloudcontrol` is partially
implemented rather than absent — which is why the health endpoint says
`running`.

**Blocks:** chant#1207 (D·aws property-level drift) and the drift step of
chant#1208 (`just aws-cc-e2e`). chant's deep reader
(`lexicons/aws/src/deep-observe.ts`) resolves each resource's physical id from
CloudFormation and then calls `GetResource` per resource. With the call refused,
every deep-readable kind reports `read-failed` and `lifecycle snapshot --deep`
degrades to an identity-only snapshot. No kind can demonstrate property drift on
Floci today, so the AWS lane's emulator-first premise does not hold for the D
slot.

**Note:** this is upstream of chant#1269. Widening `DEEP_READABLE_TYPES` changes
nothing while the call itself is refused.

---

## 2. `ListResources` returns a shallow model, and no tags

**Status:** confirmed 2026-08-01, unfiled. Related to #1 — if `GetResource`
lands with a full model, this may not matter.

```
$ aws cloudcontrol list-resources --type-name AWS::S3::Bucket
{"ResourceDescriptions":[{"Identifier":"local-…-cc1206",
  "Properties":"{\"BucketName\":\"local-…-cc1206\"}"}], "TypeName":"AWS::S3::Bucket"}

$ aws cloudcontrol list-resources --type-name AWS::EC2::SecurityGroup
… "Properties":"{\"GroupId\":\"sg-…\",\"GroupName\":\"…\",
                 \"GroupDescription\":\"app tier\",\"VpcId\":\"vpc-…\"}"
```

The bucket was deployed with versioning, encryption and a public-access block;
none appear. The security group was deployed with ingress and egress rules;
neither appears. No resource of any type carried a `Tags` key, including
resources CloudFormation created from a template that sets three tags.

**Blocks:** two things.

1. Routing the deep read through `ListResources` (the obvious workaround for #1)
   would still not give chant#1207 a property that can drift — the properties
   people hand-edit are not in the payload.
2. Ownership filtering on the deep path. `deep-observe.ts` assumes Cloud Control
   returns tags where the service carries them, so `--owned` classifies every
   resource `filtered` against Floci. Worth re-checking against real AWS before
   filing, since the assumption may hold there and only fail here.

---

## 3. VPC and Subnet are listable, though chant does not read them

**Status:** observed 2026-08-01, not a defect. Kept so the coverage discussion
has a fact under it.

```
$ aws cloudcontrol list-resources --type-name AWS::EC2::VPC
… {"VpcId":"vpc-…","CidrBlock":"10.0.0.0/16","InstanceTenancy":"default"}
```

Floci serves EC2 kinds through Cloud Control that chant's `DEEP_READABLE_TYPES`
allowlist excludes, so part of chant#1269's widening is achievable here — via
`ListResources`, and only for the shallow fields in #2.
