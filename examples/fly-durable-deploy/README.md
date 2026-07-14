# fly-durable-deploy

A Fly Machines deploy run as a **durable Temporal workflow**. `chant build`
generates the worker under `dist/ops/fly-durable-deploy/`; `chant run
fly-durable-deploy --temporal` auto-starts a local `temporal server start-dev`,
spawns the worker,
and applies the App + Machine (`src/infra.ts`) against mudflaps — durably. Crash
the worker mid-deploy and restarting it resumes from Temporal's persisted state.

Where [`fly-deploy-rollback`](../fly-deploy-rollback) uses a Sprite checkpoint as
its recovery boundary, here Temporal is the durability layer.

## Run it

```bash
docker run -d --rm -p 4280:4280 --name mudflaps ghcr.io/intentius/mudflaps:0.4.1

npm install
export FLY_FLAPS_BASE_URL=http://localhost:4280

chant build                       # dist/ops/fly-durable-deploy/
chant run fly-durable-deploy --temporal   # auto-starts Temporal + runs the durable deploy

docker rm -f mudflaps             # stop the emulator when done
```

Requires the [`temporal` CLI](https://docs.temporal.io/cli) (`brew install
temporal`) and Docker.

## Real Fly

Drop the endpoint override and give it a token — the same op:

```bash
unset FLY_FLAPS_BASE_URL
export FLY_API_TOKEN=...
chant run fly-durable-deploy --temporal
```

For a real Temporal cluster, point the `local` profile's `address` at it and set
`autoStart: false` in `chant.config.ts` (register the `OpName`/`Phase` search
attributes on that namespace once).
