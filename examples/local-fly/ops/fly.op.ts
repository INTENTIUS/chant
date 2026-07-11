import { flyDeploy } from "@intentius/chant-lexicon-fly";

/**
 * Deploy the App + Machine to a local mudflaps via `flyApply`. `chant run fly`.
 * Requires Docker. flaps has no server-side declarative apply, so `flyApply`
 * does its own GET-then-create and waits each machine to `started` over `/wait`.
 * Every phase is a modeled activity — boot, build, apply, verify, teardown —
 * with no raw shell.
 *
 * D3: the endpoint defaults to local mudflaps. To target a real Fly org, pass
 * `endpoint: null` (drops the local override) and set `FLY_API_TOKEN`.
 */
export default flyDeploy({ app: "local-fly-demo" });
