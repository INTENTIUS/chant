# bedrock-agentcore-agent — the composite/base path (#882)

Deploy a [Bedrock AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/) agent
as typed infrastructure: one `AgentCoreAgent` composite in the aws lexicon,
serialized to one CloudFormation stack, applied with the same two capabilities
every other CloudFormation-backed component in chant uses — `cfn-deploy` and
`wait-for-stack`. No bespoke verb.

## What this is

[`src/agent.ts`](src/agent.ts) calls `AgentCoreAgent(...)` from
`@intentius/chant-lexicon-aws`. That composite wires:

- `AWS::BedrockAgentCore::Runtime` — the agent's container, running on
  AgentCore Runtime.
- `AWS::BedrockAgentCore::RuntimeEndpoint` — the alias a future
  version-promotion step would repoint at a new `Runtime` version.
- `AWS::BedrockAgentCore::Memory` — session/conversation memory.
- `AWS::BedrockAgentCore::Gateway` + `GatewayTarget` — an MCP gateway whose
  default target routes back at this same agent's Runtime endpoint.
- `AWS::BedrockAgentCore::WorkloadIdentity` — a standalone identity resource
  (see the composite's doc comment for why it isn't cross-wired to
  `Runtime`/`Gateway` — both provision their own automatically, and CFN
  doesn't expose that as a settable input).
- Two `AWS::IAM::Role`s — one Runtime/Memory execute as, one Gateway assumes
  to invoke targets.

[`agent.component.ts`](agent.component.ts) deploys it: `Apply` runs
`cfn-deploy` against the template `chant build` produced, `Verify` runs
`wait-for-stack`. That's the whole release — no promotion phase.

## What's deferred

`agentcore-deploy` — a capability that would repoint `RuntimeEndpoint`'s
`TargetVersion`/`LiveVersion` at a newly-deployed `Runtime` version (a rollout,
with rollback repointing to the prior version) — is **not** implemented here.
It's deferred until a concrete version-promotion use case needs it, **and**
until Bedrock AgentCore Runtime reaches GA (the endpoint/versioning semantics
it would promote against are preview and still moving). See
[#882](https://github.com/INTENTIUS/chant/issues/882) for the full design.

Also out of scope: invoking the deployed agent (this ships the deploy target,
not a client), and any of Loom's hosted-platform surface (UI, auth, registry,
cost dashboards) — none of that is chant-shaped.

## Build, lint, deploy

```bash
npm install
npm run build     # chant build src -> dist/agent.template.json
npm run lint       # chant lint src
npm run deploy     # chant run --components all --env local --no-release-record
npm run status     # chant components status local --live --no-release-record
npm run teardown   # aws cloudformation delete-stack --stack-name bedrock-agentcore-agent
```

`containerUri` in `src/agent.ts` points at an ECR image that must already
exist — building/publishing that image is a separate, ordinary
`docker-build`/`publish-image` concern this example doesn't compose (the
point here is the AgentCore-specific declarables, not another container
pipeline).
