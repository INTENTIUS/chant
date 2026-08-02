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

**Effect on chant:** the deep reader (`lexicons/aws/src/deep-observe.ts`)
resolves each resource's physical id from CloudFormation and then calls
`GetResource` per resource. With the call refused, every deep-readable kind
reports `read-failed` and `lifecycle snapshot --deep` degrades to an
identity-only snapshot. So *as chant reads today*, no kind can be observed
deeply on Floci.

**But it does not block chant#1207, and this entry originally said it did.**
The EC2 API on the same emulator serves the same resources more completely than
Cloud Control would — see the correction under entry 2. What is blocked is the
Cloud-Control-shaped read specifically, not property-level drift as such. File
this so the emulator is honest about a service it reports as `running`, not
because a lane is waiting on it.

**Priority:** low for chant's purposes. Real AWS serves `GetResource`, so the
production path is unaffected either way.

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
   people hand-edit are not in the payload. Worse, a shallow live tree diffed
   against a full declared tree would report every undelivered property as
   drift, so this workaround is not merely weak, it is wrong.
2. Ownership filtering on the deep path. `deep-observe.ts` assumes Cloud Control
   returns tags where the service carries them, so `--owned` classifies every
   resource `filtered` against Floci. Worth re-checking against real AWS before
   filing, since the assumption may hold there and only fail here.

### Correction (2026-08-01): the EC2 API serves what Cloud Control does not

Entries 1 and 2 originally concluded that property-level drift cannot be
demonstrated on Floci. That is wrong, and the mistake was assuming the deep read
has to be Cloud Control shaped.

```
$ aws ec2 create-security-group --group-name probe --description "probe sg"
$ aws ec2 authorize-security-group-ingress --group-id sg-… --protocol tcp --port 443 --cidr 10.0.0.0/16
$ aws ec2 describe-security-groups --group-ids sg-…
… "IpPermissions":[{"IpProtocol":"tcp","FromPort":443,"ToPort":443,
                    "IpRanges":[{"CidrIp":"10.0.0.0/16"}], …}],
   "IpPermissionsEgress":[…], "Tags":[], "VpcId":"vpc-…", "Description":"probe sg"
```

The full rule set is there, and so is `Tags`. An out-of-band edit to an ingress
rule — the canonical drift case — is observable on this emulator today, through
`ec2 describe-security-groups` rather than `cloudcontrol get-resource`.

So Floci is not what stands between chant and D·aws. chant is: the deep reader
hard-codes Cloud Control as the transport for every type. chant#1271 already
argues the general form of this ("record routing from whatever API serves it"),
and this is the same finding one level down.

The catch is shape, not availability. Cloud Control returns the CloudFormation
resource model, so its payload lines up with the declared side for free. The EC2
API returns the EC2 shape — `IpPermissions` where CloudFormation declares
`SecurityGroupIngress` — so a per-type reader has to map provider shape onto the
declared shape before the diff can compare them. That mapping is the actual work
in chant#1271, and it is not free, but it is chant's to do and does not wait on
this emulator.

---

## 4. CloudFormation does not apply a security group's rules or tags — FIXED LOCALLY

**Status:** FIXED, pushed to the fork 2026-08-02, not yet upstream. Branch
`fix/cfn-security-group-rules-and-tags` on lex00/floci — open the PR to
floci-io/floci from there; `floci/floci:latest`
rebuilt from it locally, so chant's lanes are unblocked on this machine. **Still
the first thing to send upstream** — until it lands, anyone else running these
lanes hits it.

A template that declares `SecurityGroupIngress` produces a group with no rules.
The EC2 API is not at fault: the same rule added directly is stored and returned
correctly, so the gap is in the CloudFormation provider's handling of
`AWS::EC2::SecurityGroup` properties.

```
$ jq -c '.Resources.sshSecurityGroup.Properties.SecurityGroupIngress' template.json
[{"CidrIp":"203.0.113.0/24","Description":"ssh from the office","FromPort":22,"IpProtocol":"tcp","ToPort":22}]

$ aws cloudformation create-stack --stack-name local --template-body file://template.json
$ aws ec2 describe-security-groups --group-ids <the group CFN created> --query 'SecurityGroups[0].IpPermissions'
[]                                    # <- the declared rule is not there

$ aws ec2 create-security-group --group-name direct-probe --description d
$ aws ec2 authorize-security-group-ingress --group-id sg-… --protocol tcp --port 22 --cidr 203.0.113.0/24
$ aws ec2 describe-security-groups --group-ids sg-… --query 'SecurityGroups[0].IpPermissions'
[{"IpProtocol":"tcp","FromPort":22,"ToPort":22,"IpRanges":[{"CidrIp":"203.0.113.0/24"}], …}]
```

`Tags` behaves the same way: the template sets three ownership tags on the group
and the created group returns `Tags: []`.

**Blocks:** chant#1207's clean-apply half, and therefore the drift step of
chant#1208. chant can now read a security group whole (#1269), but on this
emulator every declared rule reads as absent and every declared tag as missing,
so "no false drift on a clean apply" is unreachable no matter what chant does.
Detecting an out-of-band *addition* still works; comparing against what the
template asked for does not.

**Proof that this is the only thing standing in the way.** Adding the rule the
template declared, through the EC2 API, makes chant go quiet — `0 property
drift, 1 unchanged`. Adding an out-of-band rule on top then surfaces as drift.
So the reader, the shape mapping and the noise rules are all correct on this
emulator; only the CloudFormation path is not.

```
$ aws ec2 authorize-security-group-ingress --group-id sg-… --ip-permissions \
    'IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=203.0.113.0/24,Description=ssh from the office}]'
$ chant lifecycle diff local --live
0 property drift across 0 resource(s), 0 accepted, 1 unchanged
```

**Two smaller notes for the same filing:**

- `describe-stack-resources --logical-resource-id <id>` ignores the filter and
  returns some other resource of the stack. Filter client-side until fixed.
- Worth checking whether other CloudFormation resource properties are dropped
  the same way. Only security groups were tested.

**Retracted:** an earlier revision of this entry claimed a rule's `Description`
is dropped on write. It is not — passing `--ip-permissions` with a
`Description` stores and returns it. The earlier observation came from the
`--protocol/--port/--cidr` form, which has no description parameter at all.

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

### Fix, for the upstream PR

`CloudFormationResourceProvisioner.provisionSecurityGroup` created the group
from `GroupName` / `GroupDescription` / `VpcId` and returned; nothing read
`SecurityGroupIngress`, `SecurityGroupEgress` or `Tags`. The fix translates the
template's flat rule shape (`CidrIp` / `CidrIpv6` / `SourceSecurityGroupId` on
the rule) into the nested `IpPermission` the EC2 API stores, one permission per
template rule, carrying each rule's `Description` on its source; then applies
`Tags` via `createTags`. Covered by
`CloudFormationSecurityGroupRulesIntegrationTest`.

Verified from chant's side against the rebuilt image: a stack declaring one SSH
ingress rule now reports `0 property drift, 1 unchanged` on a clean apply, and
an out-of-band `0.0.0.0/0` rule added afterwards surfaces as drift. That is both
halves of chant#1207's acceptance bar, on the canonical example.
