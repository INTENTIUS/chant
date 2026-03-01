# Example Run-Through Problems

Issues found while running all 8 examples end-to-end.

## gitlab-aws-alb-infra

1. **ECR ResourceExistenceCheck failure**: CF deploy fails if ECR repos `alb-api`/`alb-ui` already exist from a previous run. The template creates ECR repos with hardcoded names, so re-deploying after a partial teardown (where ECR repos weren't deleted) causes `AWS::EarlyValidation::ResourceExistenceCheck` failure. **Fix**: Either use `DeletionPolicy: Retain` with conditional creation, or document that ECR repos must be manually deleted before re-deploy.

2. **Build warnings** (non-blocking):
   - `mcp-tool "diff" is provided by multiple lexicons: aws, gitlab` — duplicate MCP tool registration
   - `mcp-resource "resource-catalog" is provided by multiple lexicons: aws, gitlab` — duplicate MCP resource
   - Deprecated property `ImageScanningConfiguration` on ECR repos
   - Load balancer missing access logging (`access_logs.s3.enabled`)

## gitlab-aws-alb-api

3. **Health check path mismatch for new users**: The template hardcodes `healthCheckPath: "/api/get"` and `containerPort: 8080` (matching the default `go-httpbin` image). A new user adding their own Dockerfile must know to serve on 8080 and expose that exact health check path. README says "Add your app — add a `Dockerfile`" but doesn't mention port 8080 or the health check path requirement. **Fix**: Document the required port and health check path in README, or make them configurable parameters.

4. **README teardown uses wrong stack name**: README says `aws cloudformation delete-stack --stack-name alb-api` but the generated `.gitlab-ci.yml` deploys to stack name `shared-alb-api`. **Fix**: Update README teardown commands to use `shared-alb-api`.

5. **Race condition on redeploy**: If a stack is in DELETE_IN_PROGRESS when a new pipeline runs, the deploy fails with "Stack is in DELETE_IN_PROGRESS state". No retry logic in the pipeline. **Fix**: Add wait-for-delete or use `--no-fail-on-empty-changeset` with a retry.

## flyway-postgresql-gitlab-aws-rds

## gitlab-aws-alb-infra (teardown)

6.5. **ECR repos block stack deletion**: ECR repos with images can't be deleted by CloudFormation (no `EmptyOnDelete` or force-delete). Stack teardown fails with "cannot be deleted because it still contains images". User must manually `aws ecr delete-repository --force` before deleting the stack. **Fix**: Consider adding `DeletionPolicy` or documenting this in teardown instructions.

## flyway-postgresql-gitlab-aws-rds

## k8s-batch-workers

7. **BatchJob composite: memory request > limit** (BUG): The `BatchJob` composite sets default memory limit of 256Mi, but the example sets `memoryRequest: "512Mi"`. Kubernetes rejects this (`must be less than or equal to memory limit`). The composite should either set limits >= requests automatically, or validate at build time. The linter doesn't catch this either — it warns about missing limits but not about request > limit. **Fix**: Ensure composite defaults don't conflict with user-specified requests. Had to change `memoryRequest` to `"256Mi"` to proceed.

8. **29 lint/build warnings** (non-blocking): The example produces 29 warnings about missing imagePullPolicy, resource limits, readOnlyRootFilesystem, runAsNonRoot, capabilities, probes, and PDBs. While these are best-practice warnings, having this many on a built-in example sends the wrong signal to new users. **Fix**: Address at least the critical warnings (limits, probes) in the example code.

## k8s-web-platform

9. **SidecarApp (api) pods crash**: The `api` Deployment with Envoy sidecar has pods in CrashLoopBackOff. The sidecar container likely needs a valid Envoy config that isn't provided. The `api-isolated` pods also crash. Only `frontend` pods are healthy. The deploy script only waits for `frontend`, so it "passes" despite 6 of 8 pods crashing. **Fix**: Either provide a minimal Envoy config or use a mock sidecar image that doesn't crash, so all pods are healthy out of the box.

10. **README doesn't mention nginx ingress must be ready before apply**: The Ingress resource triggers nginx's admission webhook. If the webhook isn't ready yet, `kubectl apply` fails with "no endpoints available for service". README should mention waiting for the ingress controller before deploying. **Fix**: Add a wait step or note about timing.

## k8s-eks-microservice

11. **Stack deploys to default AWS region, not `us-east-1`**: The `deploy-infra` script uses `aws cloudformation deploy` without `--region`, so it uses the CLI's default region. The `.env` has `AWS_REGION=us-east-1` but the deploy command doesn't use it. If user's default region differs, the stack deploys to the wrong region. **Fix**: Pass `--region $AWS_REGION` in the deploy-infra script.

12. **58 build warnings**: Similar to other K8s examples — lots of missing tags (AWS), imagePullPolicy, resource limits, security context, probes (K8s). Particularly noisy for a "production-grade" example. **Fix**: Address warnings in the example code to demonstrate best practices.

## flyway-postgresql-gitlab-aws-rds

6. **RdsInstance composite missing security group ingress rule** (BUG): The example `database.ts` used `dbIngressCidr.Ref` but the `Parameter` class has no `.Ref` property, so it returned `undefined`. The `RdsInstance` composite's `ingressCidr` was silently undefined, and no ingress rules were added to the SecurityGroup. Result: RDS is publicly accessible (`PubliclyAccessible: true`) but the SG blocks all inbound traffic on port 5432. **Fixed**: Changed to `Ref(dbIngressCidr)` intrinsic function. The composite's ingress logic was always correct — the bug was in how the example passed the parameter reference.

13. **YAML parser drops nested objects in array items** (BUG): `packages/core/src/yaml.ts` `parseYAMLArray()` only calls `parseScalar()` for subsequent keys in array items (line 277), not `parseYAMLLines()`. Nested objects like `resources.limits` inside container array items are parsed as `null`. This causes all K8s post-synth lint rules that inspect container contents (WK8201-resources, WK8202-probes, WK8203-securityContext, etc.) to report false-positive warnings. The generated YAML is correct — only the parser used by the linter is broken. **Fix**: `parseYAMLArray()` needs to recursively parse nested objects within array items.
