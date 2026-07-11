# @intentius/chant-lexicon-fly

The Fly.io lexicon for [chant](https://intentius.io/chant/). Declare Fly apps, machines, volumes, IPs, certificates, and secrets as typed TypeScript and apply them straight to the Fly Machines API.

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-fly
```

## What it does

chant is a type system for operations: you describe infrastructure as typed TypeScript, and each lexicon turns those declarations into real provider API calls. This one covers Fly.

The resource types (`App`, `Machine`, `Volume`, `IPAddress`, `Certificate`, `Secret`) are generated from Fly's own Machines API OpenAPI spec, so they track the real API and give you full editor autocomplete. A build step lints them, and `flyApply` reconciles them against a Fly org over the Machines API (flaps) directly.

It fits two kinds of user: teams running on Fly who want their infrastructure as typed, reviewed, reconciled code rather than imperative CLI calls, and platform engineers who already manage AWS, GCP, or Kubernetes through chant and want Fly in the same model.

## Author infrastructure as typed code

```ts
import { App, Machine, MachineConfig, MachineGuest } from "@intentius/chant-lexicon-fly";

export const app = new App({ name: "my-app" });

export const web = new Machine({
  region: "iad",
  config: new MachineConfig({
    image: "flyio/hellofly:latest",
    guest: new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 256 }),
  }),
});
```

`MachineConfig` is typed all the way down through guest, services, mounts, and checks, because the whole graph is generated from the Machines API spec.

## Apply without a state file

`flyApply` speaks the Machines API directly. There is no `flyctl` shell-out and no state file to store, lock, or keep in sync. It reconciles what you declared against what is actually running:

- Creates and updates machines, then waits each one to `started` over the Machines API `/wait` endpoint.
- Prunes only what chant owns. Every machine chant creates carries a `managed-by: chant` marker, and a machine without it is never modified or deleted, so the applier is safe to point at an app that also holds resources you manage elsewhere.
- Speaks the Machines API lease protocol: acquire a lease, send the nonce on each mutation, re-acquire and retry if the lease is lost, so concurrent operators stay out of each other's way.

The endpoint is a single switch. Set `FLY_FLAPS_BASE_URL` (or pass an `endpoint`) to choose between a real Fly org and a local emulator with no code change.

## Catch mistakes at build time

Lint rules run during `chant build`, before anything reaches the API:

- `region` must be a real Fly region.
- Guest sizing (`cpu_kind` / `cpus` / `memory_mb`) must be a valid combination.
- Every machine mount must reference a `Volume` declared in the stack, checked across files.
- Secret values may not be written inline; they belong in a `Secret` or a reference.

## Deploy, and test the whole loop offline

The lexicon ships a deploy Op that runs the phases boot, build, apply, verify, and teardown, and a runnable [`examples/local-fly`](../../examples/local-fly) starter. The Fly Machines API is emulated by [mudflaps](https://github.com/intentius/mudflaps), so the entire deploy loop runs against a local container in CI, with no Fly account:

```bash
cd examples/local-fly
chant run fly        # boots mudflaps, applies an App + Machine, waits for started, tears down
```

Drop the local endpoint and set `FLY_API_TOKEN`, and the same Op deploys to a real Fly org.

## Compared to a Terraform provider for Fly

|              | Terraform for Fly                        | This lexicon                                            |
| ------------ | ---------------------------------------- | ------------------------------------------------------- |
| **State**    | A `.tfstate` to store, lock, and back up | None; reconciles from live state + the ownership marker |
| **Language** | HCL                                      | TypeScript, types generated from the Machines API spec  |
| **Testing**  | Against a real Fly org                   | Offline against the mudflaps emulator, in CI            |

The same code applies to a local emulator and to a real Fly org; the only difference is the endpoint.

## Related packages

| Package                                                                                    | Role                                  |
| ------------------------------------------------------------------------------------------ | ------------------------------------- |
| [@intentius/chant](https://www.npmjs.com/package/@intentius/chant)                         | Core type system, CLI, build pipeline |
| [@intentius/chant-lexicon-aws](https://www.npmjs.com/package/@intentius/chant-lexicon-aws) | AWS CloudFormation lexicon            |
| [@intentius/chant-lexicon-gcp](https://www.npmjs.com/package/@intentius/chant-lexicon-gcp) | GCP Deployment Manager lexicon        |

## License

See the main project LICENSE file.
