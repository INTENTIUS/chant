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

## 5. Organizations service is entirely absent

**Status:** confirmed 2026-08-07, unfiled. Blocked the archived governance-reconcile e2e (see `archive/wardens-monorepo-state`): every governance cycle starts
from `ListRoots`, so no part of the org-unit / policy-guardrail surface can be
exercised against the emulator.

```
$ curl -s -X POST http://localhost:4599/ \
    -H "Content-Type: application/x-amz-json-1.1" \
    -H "X-Amz-Target: AWSOrganizationsV20161128.CreateOrganization" \
    -d '{"FeatureSet":"ALL"}'
{"__type":"UnknownOperationException","message":"Unknown operation: AWSOrganizationsV20161128.CreateOrganization"}
```

Confirmed against `floci/floci:1.5.34`: `/_localstack/health` lists no
`organizations` service at all (the full service list has 70 entries;
`cloudtrail` is present and `running`). That e2e's bootstrap probes
health for `"organizations"` and exits without exporting `AWS_ENDPOINT_URL`,
so the suite self-skips (green, with a notice) until the emulator gains the
service. Fallback for a real run: a live sandbox org in dry-run.

The identity-assignment cycle (chant#792) is behind the same skip: floci's
service catalog has neither `sso-admin` (IAM Identity Center) nor
`identitystore` (checked in the floci source's ServiceCatalog, 2026-08-07),
and every identity fetch starts from `ListInstances`. The in-memory
convergence suite (archived with the branch above) covers
the identity loop meanwhile, like the other governance cycles.

## 6. floci-gcp: GCS bucket insert drops `iamConfiguration`

**Status:** confirmed 2026-08-07 against `floci/floci-gcp:0.5.0`, unfiled
(upstream: floci-io/floci-gcp).

```
$ docker run -d --rm -p 4588:4588 floci/floci-gcp:0.5.0
$ curl -s -X POST 'http://localhost:4588/storage/v1/b?project=local-project' \
    -H 'content-type: application/json' \
    -d '{"name":"g","iamConfiguration":{"uniformBucketLevelAccess":{"enabled":true}}}'
$ curl -s http://localhost:4588/storage/v1/b/g
{"kind":"storage#bucket","id":"g", … "name":"g", …}     # no iamConfiguration
```

Real GCS persists `iamConfiguration` and returns it on GET. The emulator
accepts the field and drops it, so a chant estate declaring
`uniformBucketLevelAccess: true` reports one `absent` property drift on a
clean apply (chant#1210's acceptance run). Detection is correct — the live
resource genuinely does not carry the configuration — the emulator is what
loses it. Same class as entry 4 (CloudFormation dropping SG rules), one
emulator over.

## 7. floci-az: the modeled storage-account provider does not persist what was PUT

**Status:** confirmed 2026-08-07 against `floci/floci-az:0.10.0`, unfiled.
This is the azure sibling (floci-io/floci-az), not floci — recorded here
because it is the same one-pass upstream filing.

Generic ARM types (NSGs, VNets, route tables) round-trip: floci-az stores the
PUT body and GETs return it, tags and nested collections included — which is
what the azure drift acceptance (`test/azure-drift-e2e.sh`, chant#1213) rides.
`Microsoft.Storage/storageAccounts` is instead a *modeled* provider, and the
model discards the request:

```
$ curl -s -X PUT "$BASE/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/s1?api-version=2023-01-01" \
    -H 'content-type: application/json' \
    -d '{"location":"eastus","tags":{"environment":"e2e"},"sku":{"name":"Standard_LRS"},"kind":"StorageV2",
         "properties":{"minimumTlsVersion":"TLS1_2","allowBlobPublicAccess":false,"supportsHttpsTrafficOnly":true,
                       "networkAcls":{"bypass":"AzureServices","defaultAction":"Deny","ipRules":[],"virtualNetworkRules":[]}}}'
$ curl -s "$BASE/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/s1?api-version=2023-01-01"
```

The GET drops `tags` entirely, drops `minimumTlsVersion` /
`allowBlobPublicAccess` / `networkAcls`, returns `supportsHttpsTrafficOnly:
false` against the requested `true`, and adds a modeled surface
(`accessTier`, `primaryEndpoints.*`, `primaryLocation`, `statusOfPrimary`,
`sku.tier`).

What it blocks: a storage account cannot appear in a drift acceptance estate —
every declared secure-default reads as `absent` drift and the flipped
`supportsHttpsTrafficOnly` reads as `changed`, all of it emulator artifact.
The drift e2e uses the VnetDefault networking estate instead; entry stands
until the provider either echoes unknown properties like the generic path or
models the requested values.

## 8. floci-az: an AKS cluster never reaches Succeeded, and its admin credential is a mock

**Status:** confirmed 2026-08-07 against `floci/floci-az:0.10.0` running in
Docker (`-v /var/run/docker.sock:/var/run/docker.sock`), unfiled (upstream:
floci-io/floci-az).

Two symptoms, one root: the finalize path — poll the k3s apiserver, extract
`/etc/rancher/k3s/k3s.yaml`, rewrite the server — never runs in the 0.10.0
image when the emulator itself is a container.

```
$ curl -s -X PUT "$BASE/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/probe?api-version=2024-02-01" \
    -H 'content-type: application/json' -d '{"location":"eastus","properties":{"dnsPrefix":"probe"}}'
{… "provisioningState":"Creating", "fqdn":"floci-az-aks-<id>:6443" …}
# The k3s container comes up and its apiserver answers (/livez → 401 anonymous,
# kubectl through the extracted k3s.yaml works), but the cluster stays
# "Creating" indefinitely — silently, no poller error in the emulator log.

$ curl -s -X POST ".../managedClusters/probe/listClusterAdminCredential?api-version=2024-02-01"
# kubeconfig decodes to server https://floci-az-aks-<id>:6443 (a docker-network
# name the host cannot resolve) with token "floci-az-mock-token", which the
# real k3s rejects ("the server has asked for the client to provide credentials").
```

The floci-az source (`AksClusterManager.finalizeCluster` + the
`aks-readiness-poller`, accepting 200/401/403 from `/livez` and polling an
internal-IP endpoint) does all of this correctly — it is just not what the
0.10.0 image does; the image's poller never confirms readiness (likely polling
the container-name endpoint, unresolvable on the default bridge, or requiring
a 200 that k3s's anonymous-auth-off apiserver never returns).

**Effect on chant:** `test/azure-cc-e2e.sh` gates on the cluster's own
`/readyz` through an extracted kubeconfig rather than on `provisioningState`,
and performs floci-az's own finalize itself: `docker exec <k3s> cat
/etc/rancher/k3s/k3s.yaml`, server rewritten to the host-published port. It
still asserts `listClusterAdminCredential` answers and names the cluster's
endpoint, so an upstream fix will not break the harness.

Also worth carrying in the same filing: a k3s container from a dead emulator
is never cleaned up (the harness removes its own by the cluster's fqdn), and a
stale `floci-az-aks-*` holding host port 6443 makes the next cluster's k3s
fail to start — the port allocator only knows its own allocations.

## 9. floci-az: the modeled managedClusters provider drops declared AKS surface

**Status:** confirmed 2026-08-07 against `floci/floci-az:0.10.0`, unfiled.
Same class as entry 7, one provider over.

```
$ curl -s -X PUT ".../managedClusters/echo?api-version=2023-08-01" -H 'content-type: application/json' \
    -d '{"location":"eastus","tags":{...},"identity":{"type":"SystemAssigned"},
         "properties":{"kubernetesVersion":"1.29.0","dnsPrefix":"echo","enableRBAC":true,
           "agentPoolProfiles":[{"name":"default","count":1,"vmSize":"Standard_B2s","osType":"Linux",
                                 "mode":"System","enableAutoScaling":false,"type":"VirtualMachineScaleSets"}],
           "networkProfile":{...},"addonProfiles":{...}}}'
```

The echo (and every later GET) keeps `location`/`tags`/`kubernetesVersion`/
`dnsPrefix`/`enableRBAC` and the pool's `name`/`count`/`vmSize`/`osType`/
`mode` — and drops `identity`, `networkProfile`, `addonProfiles` and the
pool's `enableAutoScaling`/`type`, while adding computed surface
(`currentKubernetesVersion`, `fqdn`, `nodeResourceGroup`, per-pool
`provisioningState`).

**Effect on chant:** the AksCluster composite's production defaults would put
honest-but-emulator-made `absent` drift on every clean apply, so
`examples/cc-azure-canonical` declares a raw managedCluster carrying exactly
the surface that round-trips. The added computed fields are genuinely
read-only in real Azure and normalize away via `AZURE_SERVER_COMPUTED_NAMES`
(counterpart-gated — a declared `nodeResourceGroup` is still compared).

## 10. floci-az: managedClusters are absent from the resource-group resource list

**Status:** confirmed 2026-08-07 against `floci/floci-az:0.10.0`, unfiled.

```
$ curl -s "$BASE/resourceGroups/rg/resources?api-version=2021-04-01"
{"value":[ …every generic ARM resource in the group, full bodies… ]}
# The AKS cluster created above is not in the list, though GET on its own URL
# returns it. Modeled providers keep their own store; the RG listing only
# covers the generic one.
```

**Effect on chant:** live export over ARM (`chant import --from <env>` with
`AZURE_ENDPOINT_URL` set, #1214) enumerates the group through this listing, so
a reconcile regenerates the networking estate but cannot carry the AKS
cluster; the authored cluster source stays as-is. `test/azure-cc-e2e.sh`
asserts exactly that split. Entry stands until the listing includes modeled
providers.

## 11. `AWS::CloudWatch::Dashboard` deploys via CloudFormation but the CloudWatch API refuses to read it back

**Status:** confirmed 2026-08-24 against `floci/floci:latest`, unfiled. Found
while building the `MonitoringStack` composite (chant#1139).

```
$ aws cloudformation deploy --stack-name monitoring-stack-check --template-file template.json
Successfully created/updated stack - monitoring-stack-check

$ aws cloudformation describe-stack-resources --stack-name monitoring-stack-check \
    --query 'StackResources[?ResourceType==`AWS::CloudWatch::Dashboard`]'
[{"LogicalResourceId":"monitoringDashboard","PhysicalResourceId":"monitoringDashboard-28e4fce3",
  "ResourceType":"AWS::CloudWatch::Dashboard","ResourceStatus":"CREATE_COMPLETE"}]

$ aws cloudwatch list-dashboards
An error occurred (UnsupportedOperation) when calling the ListDashboards operation:
Operation ListDashboards is not supported by CloudWatch JSON.

$ aws cloudwatch get-dashboard --dashboard-name floci-check-dashboard
An error occurred (UnsupportedOperation) when calling the GetDashboard operation:
Operation GetDashboard is not supported by CloudWatch JSON.
```

CloudFormation's own resource-type handler accepts the create and reports
`CREATE_COMPLETE` (`monitoring` shows `"running"` on `/_localstack/health`),
but the CloudWatch service surface behind that same emulator has no
dashboard-reading operations at all — not partial, absent.

**Effect on chant:** synthesis and `cfn-deploy` for a `CwDashboard` resource
(via the new `MonitoringStack` composite or a bare declaration) both work
end-to-end on Floci, so the write half of the composite's Floci coverage is
real. What cannot be exercised here is reading the dashboard back — a
`lifecycle snapshot --deep`/live-diff over a Dashboard degrades exactly like
entry 1's Cloud Control gap, for the same underlying reason (the emulator
reports a service `running` that only partially implements it). The
`AWS::CloudWatch::Alarm` half has no such gap — `describe-alarms` returns the
alarm with every property (`Namespace`, `MetricName`, `Dimensions`,
`Threshold`, `ComparisonOperator`, `EvaluationPeriods`) round-tripped exactly.

**Priority:** low. Real AWS serves both operations; the composite's write
path (the half a `cfn-deploy` estate depends on) is unaffected.

## 12. `AWS::CloudWatch::Dashboard`'s physical id ignores the declared `DashboardName`

**Status:** confirmed 2026-08-24 against `floci/floci:latest`, unfiled. Same
deploy as entry 11.

The CloudFormation schema for `AWS::CloudWatch::Dashboard` declares
`DashboardName` as `createOnly` and its `primaryIdentifier` — on real AWS the
physical resource id is the dashboard name you set (or a generated one only
when you omit it). Here, with `DashboardName: "floci-check-dashboard"`
explicit in the deployed template, `describe-stack-resources` still reports
`PhysicalResourceId: "monitoringDashboard-28e4fce3"` — the logical id plus a
random suffix, not the name that was declared.

**Effect on chant:** nothing observed yet — nothing in the composite or its
tests depends on the dashboard's physical id, and the property itself
(`DashboardName`) round-trips correctly in the template and (per entry 11) is
unreadable back from the API either way. Filed because a future live-read or
drift check over dashboards would trip on it: the physical id a `describe-
stack-resources` call reports would not match the name an estate declared.

**Priority:** low, same reasoning as entry 11.

## 13. CloudFormation `AWS::ECR::Repository` drops `ImageScanningConfiguration`

**Status:** confirmed 2026-08-24 against `ghcr.io/lex00/floci:latest`,
unfiled. Found while building the `EcrRepository` composite (chant #1139).

```
$ docker run -d --rm --name chant-floci-ecr -p 4600:4566 ghcr.io/lex00/floci:latest
$ export AWS_ENDPOINT_URL=http://localhost:4600 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1

$ cat > template.json <<'JSON'
{
  "AWSTemplateFormatVersion": "2010-09-09",
  "Resources": {
    "Repo": {
      "Type": "AWS::ECR::Repository",
      "Properties": {
        "RepositoryName": "chant-ecr-verify",
        "ImageTagMutability": "MUTABLE",
        "ImageScanningConfiguration": {"ScanOnPush": true},
        "LifecyclePolicy": {"LifecyclePolicyText": "{\"rules\":[{\"rulePriority\":1,\"selection\":{\"tagStatus\":\"untagged\",\"countType\":\"sinceImagePushed\",\"countUnit\":\"days\",\"countNumber\":14},\"action\":{\"type\":\"expire\"}}]}"}
      }
    }
  }
}
JSON
$ aws cloudformation create-stack --stack-name ecr-verify --template-body file://template.json
$ aws cloudformation wait stack-create-complete --stack-name ecr-verify

$ aws ecr describe-repositories --repository-names chant-ecr-verify \
    --query 'repositories[0].imageScanningConfiguration'
{"scanOnPush": false}

$ aws ecr get-lifecycle-policy --repository-name chant-ecr-verify
{"lifecyclePolicyText": "{\"rules\":[{\"rulePriority\":1,\"selection\": …}]}", …}
```

The template asked for `ScanOnPush: true`; the repository that comes back
has scanning off. `LifecyclePolicy`, `ImageTagMutability`, and
`EncryptionConfiguration` all round-trip correctly through the same
CloudFormation create — only `ImageScanningConfiguration` is dropped.

The raw ECR API is not at fault — `create-repository
--image-scanning-configuration scanOnPush=true` against the same emulator
returns `{"scanOnPush": true}` immediately. (The companion
`put-image-scanning-configuration` call is a dead end for isolating this
further: AWS itself deprecated that operation in favor of registry-level
scanning config, and Floci returns `UnsupportedOperation` for it — consistent
with real ECR, not a gap.) So this is specifically the CloudFormation
resource-provider glue for `AWS::ECR::Repository` silently dropping one
documented property, not an ECR gap.

**Effect on chant:** the `EcrRepository` composite (defaults `scanOnPush` to
`true`) synthesizes correct CloudFormation, but a Floci-backed
`cfn-deploy`/apply loop cannot assert scan-on-push took effect —
`describe-repositories` reads back the pre-gap `false`. The composite's own
tests stay unit-level (construct the template, assert its shape) rather than
asserting post-apply state through Floci; the manual repro above is the
closest this got to emulator coverage. Unblocked by switching the assertion
to the raw ECR `create-repository` API instead of describe-after-CFN, which
is not representative of how these repositories are actually deployed.

## 14. CloudFormation drops most declared `AWS::S3::Bucket` sub-configuration, and `AWS::S3::BucketPolicy` applies nothing at all

**Status:** confirmed 2026-08-24 against `floci/floci:1.5.34`, unfiled. Same
class as entry 4 (CloudFormation not applying a declared resource's
properties) — S3, not EC2 security groups, this time. Found building the
`BucketDeployment` composite (chant#1139) — a bucket declaring encryption,
a public-access-block, a website configuration and a tag through
CloudFormation, plus a sibling `AWS::S3::BucketPolicy`.

```
$ aws cloudformation create-stack --stack-name probe --template-body file://template.json
# template.json declares one AWS::S3::Bucket with BucketEncryption,
# PublicAccessBlockConfiguration (open, for the website case),
# WebsiteConfiguration and one Tag, plus one AWS::S3::BucketPolicy
# (Bucket: {Ref: bucket}) granting public s3:GetObject.
$ aws cloudformation describe-stacks --stack-name probe --query 'Stacks[0].StackStatus'
"CREATE_COMPLETE"
$ aws cloudformation describe-stack-resources --stack-name probe
# both siteBucket and siteBucketPolicy report CREATE_COMPLETE

$ aws s3api get-bucket-encryption --bucket chant-bucket-deployment-probe
{"ServerSideEncryptionConfiguration":{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},...}]}}   # <- correct

$ aws s3api get-bucket-website --bucket chant-bucket-deployment-probe
An error occurred (NoSuchWebsiteConfiguration) …                 # <- declared, not applied
$ aws s3api get-bucket-tagging --bucket chant-bucket-deployment-probe
{"TagSet":[]}                                                     # <- declared one tag, applied none
$ aws s3api get-public-access-block --bucket chant-bucket-deployment-probe
An error occurred (NoSuchPublicAccessBlockConfiguration) …       # <- declared, not applied
$ aws s3api get-bucket-policy --bucket chant-bucket-deployment-probe
An error occurred (NoSuchBucketPolicy) …                          # <- CREATE_COMPLETE, applies nothing
```

Every one of the four round-trips through the plain S3 API once put there
directly instead of through CloudFormation:

```
$ aws s3api put-bucket-website --bucket ... --website-configuration '{"IndexDocument":{"Suffix":"index.html"}}'
$ aws s3api get-bucket-website --bucket ...
{"IndexDocument":{"Suffix":"index.html"}}                         # <- round-trips
$ aws s3api put-bucket-tagging --bucket ... --tagging '{"TagSet":[{"Key":"env","Value":"prod"}]}'
$ aws s3api get-bucket-tagging --bucket ...
{"TagSet":[{"Key":"env","Value":"prod"}]}                          # <- round-trips
$ aws s3api put-public-access-block --bucket ... --public-access-block-configuration BlockPublicAcls=true,...
$ aws s3api get-public-access-block --bucket ...
{"PublicAccessBlockConfiguration":{"BlockPublicAcls":true,...}}   # <- round-trips
$ aws s3api put-bucket-policy --bucket ... --policy '{"Version":"2012-10-17","Statement":[...]}'
$ aws s3api get-bucket-policy --bucket ...
{"Policy":"{...}"}                                                 # <- round-trips
```

So the S3 API itself is fine on this emulator (encryption also round-trips
correctly through CloudFormation, singling it out as the one sub-resource
the provider does forward) — the gap is `CloudFormationResourceProvisioner`'s
S3 bucket path calling only the encryption API and silently skipping
`WebsiteConfiguration`, `PublicAccessBlockConfiguration` and `Tags`, and its
`AWS::S3::BucketPolicy` provisioner not calling `PutBucketPolicy` at all
despite reporting `CREATE_COMPLETE`.

**Effect on chant:** `BucketDeployment` (chant#1139) declares all four on
Floci and a clean apply will read back as if none of them were ever asked
for — the composite itself is correct (`aws cloudformation get-template`
still shows every property; this is purely an apply-time gap), so the
composite's tests exercise the generated template's shape directly rather
than a Floci round-trip. A drift-acceptance estate built on this composite
would report false `absent` drift on all four properties until this lands,
the same shape as entry 4's SG rules — actual out-of-band drift (a rule
added on top of what CloudFormation *did* apply) would still surface
correctly for `BucketEncryption`, the one property this path forwards.

## 15. CloudFormation `AWS::DynamoDB::Table` drops StreamSpecification and TimeToLiveSpecification, ignores custom ProvisionedThroughput

**Status:** confirmed 2026-08-24 against `ghcr.io/lex00/floci:main-20260825a`
(`latest`), unfiled. Found while building the `DynamoDBTable` composite
(chant #1139).

```
$ docker run -d --rm --name chant-floci-dynamo -p 4599:4566 ghcr.io/lex00/floci:latest
$ export AWS_ENDPOINT_URL=http://localhost:4599 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1

$ cat > template.json <<'JSON'
{
  "AWSTemplateFormatVersion": "2010-09-09",
  "Resources": {
    "T": {
      "Type": "AWS::DynamoDB::Table",
      "Properties": {
        "TableName": "chant-dynamo-verify",
        "BillingMode": "PROVISIONED",
        "AttributeDefinitions": [{"AttributeName": "pk", "AttributeType": "S"}],
        "KeySchema": [{"AttributeName": "pk", "KeyType": "HASH"}],
        "ProvisionedThroughput": {"ReadCapacityUnits": 2, "WriteCapacityUnits": 2},
        "StreamSpecification": {"StreamViewType": "NEW_AND_OLD_IMAGES"},
        "TimeToLiveSpecification": {"Enabled": true, "AttributeName": "expiresAt"}
      }
    }
  }
}
JSON
$ aws cloudformation create-stack --stack-name dynamo-verify --template-body file://template.json
$ aws cloudformation wait stack-create-complete --stack-name dynamo-verify

$ aws dynamodb describe-table --table-name chant-dynamo-verify \
    --query 'Table.{Prov:ProvisionedThroughput,Stream:StreamSpecification}'
{
    "Prov": {"NumberOfDecreasesToday": 0, "ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
    "Stream": null
}
$ aws dynamodb describe-time-to-live --table-name chant-dynamo-verify
{"TimeToLiveDescription": {"TimeToLiveStatus": "DISABLED"}}
```

The template asked for `ReadCapacityUnits`/`WriteCapacityUnits` of 2/2, a
stream, and TTL on `expiresAt`. The table that comes back has the emulator's
default 5/5 capacity, no `StreamSpecification` at all (so no `StreamArn`
either), and TTL still disabled. A GSI's own `ProvisionedThroughput` in the
same template comes back as `0/0` rather than the value given.

The raw DynamoDB API is not at fault — `create-table` with the same
`--provisioned-throughput`/`--stream-specification`, followed by
`update-time-to-live`, applies all three correctly on the same emulator (see
repro in the PR that added this entry, chant #1139). So this is specifically
the CloudFormation resource-provider glue for `AWS::DynamoDB::Table` silently
dropping three of its documented properties, not a DynamoDB gap.

**Effect on chant:** any composite or hand-authored template that sets
`Table.StreamSpecification`, `Table.TimeToLiveSpecification`, or a non-default
`ProvisionedThroughput` (table- or GSI-level) synthesizes correctly and the
generated CloudFormation is right, but a Floci-backed `cfn-deploy`/apply loop
cannot be used to assert those settings took effect — `describe-table` and
`describe-time-to-live` read back the pre-gap state. The `DynamoDBTable`
composite's own tests therefore stay unit-level (construct the template,
assert its shape) rather than asserting post-apply state through Floci; the
manual repro above is the closest this got to emulator coverage. Unblocked by
switching the assertion to the raw DynamoDB API instead of describe-after-CFN,
which is not representative of how these tables are actually deployed.
