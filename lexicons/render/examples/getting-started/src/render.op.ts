import { renderDeploy } from "@intentius/chant-lexicon-render";

/**
 * Deploy the Postgres + web service to a Render workspace via `renderApply`.
 * `chant run render`. Needs RENDER_API_KEY (and RENDER_OWNER_ID when the key
 * sees more than one workspace). Render has no server-side declarative apply,
 * so `renderApply` finds each resource by name, creates or PATCHes it, and
 * waits the web service's first deploy to `live`. Both phases are modeled
 * activities — build, apply — with no raw shell.
 */
export default renderDeploy({
  overview: "Render: Postgres + web service → workspace (direct Public API apply)",
});
