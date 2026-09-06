/**
 * `chant init` scaffolding for fountain projects.
 *
 * Three templates. The default is the concierge posture — a locked sandbox
 * declared through `ConciergeStack`, since an agent environment that reaches
 * anything real should start closed and be opened by explicit parameter. The
 * `open` template is the loose counterpart for a research sandbox that touches
 * nothing sensitive, and says so in a comment rather than leaving a reader to
 * infer that the difference was deliberate.
 *
 * `steward` (chant #2129) is the ops posture: a toolchain `Environment` a
 * chant checkout runs from, a `Vault` placeholder for whatever the ops need,
 * a `WatchOp` and a `ConvergeOp` on cadences, and a `Steward` binding them so
 * every run lands on one teammate's thread. It is the only template that ships
 * a `chant.config.ts`, because it is the only one whose commands do not work
 * without one: `chant run <op> --on fountain` needs an endpoint and a token,
 * and `fountain.profiles` is where those are declared.
 */

import type { InitTemplateSet } from "@intentius/chant/lexicon";

const CONCIERGE = `import { ConciergeStack } from "@intentius/chant-lexicon-fountain";

// A locked-down Environment + Agent pair. The defaults are the closed ones:
// deny-all egress (limited networking with an empty allowlist), no vault may
// override the reviewed environment at spawn, and the managed-by: chant marker
// on both so owned-only reconcile and drift see them.
//
// Loosening any of it is an explicit, reviewable parameter — add hosts to
// allowedHosts, ids to allowedVaultIds. Give the sandbox no cloud credentials:
// anything readable inside it is exfiltratable by prompt injection. Services
// the agent needs live outside the sandbox behind their own auth.
export const { environment, agent } = ConciergeStack({
  name: "concierge",
  model: "anthropic/claude-sonnet-4-6",
  allowedHosts: ["registry.npmjs.org", "github.com"],
});
`;

const OPEN = `import { Environment, Agent } from "@intentius/chant-lexicon-fountain";

// A research sandbox that touches nothing sensitive. networking_type is set
// explicitly because FTN010 requires the choice to be a reviewed one, not a
// default nobody looked at; FTN011 will still warn on unrestricted, which is
// the intended nudge — switch to limited with an allowed_hosts allowlist as
// soon as this environment holds anything worth stealing.
export const env = new Environment({
  name: "research-env",
  networking_type: "unrestricted",
  packages: { node: "24" },
  metadata: { "managed-by": "chant" },
});

export const researcher = new Agent({
  name: "researcher",
  model: "anthropic/claude-sonnet-4-6",
  runtime: "claude",
  environment: env,
  metadata: { "managed-by": "chant" },
});
`;

// The two scheduled ops live in their own `*.op.ts` files rather than beside
// the resources, because that suffix is what `chant run` discovers: an Op
// declared in `fountain.ts` builds fine and then reports "no such Op" the
// first time anyone tries to run it. The `Steward` below imports both, so the
// cadence is still written once, on the Op it paces.
const STEWARD_WATCH_OP = `// Every quarter hour: snapshot prod and diff it against the declaration.
//
//   chant run prod-watch                 # here, on the local executor
//   chant run prod-watch --on fountain   # on the steward, as a turn

import { WatchOp } from "@intentius/chant/op";

const { op } = WatchOp({
  name: "prod-watch",
  env: "prod",
  schedule: "*/15 * * * *",
});

export default op;
`;

const STEWARD_CONVERGE_OP = `// Hourly, on the observe dial: report what has drifted and act on nothing.
//
// Every rule carries its why, and the dial is the authority the environment
// grants. Turning it to \`reconcile\` or \`apply\` is a separate, reviewable edit
// rather than something a rule can decide for itself.

import { ConvergeOp, gt, report, when } from "@intentius/chant/op";

const { op } = ConvergeOp({
  name: "prod-converge",
  env: "prod",
  dial: "observe",
  schedule: "0 * * * *",
  rules: [
    when(gt("updateCount", 0), report("declared and live state disagree"), {
      id: "prod-drift",
      why: "An update pending against prod means something changed outside this repo; say so before anything acts on it.",
    }),
  ],
});

export default op;
`;

const STEWARD = `import { params } from "@intentius/chant/params";
import {
  Environment,
  Repository,
  Steward,
  Vault,
} from "@intentius/chant-lexicon-fountain";
import prodConverge from "./prod-converge.op";
import prodWatch from "./prod-watch.op";

/** The ownership marker. Owned-only reconcile, prune and drift all key on it. */
export const chantOwned = { "managed-by": "chant" };

/** Everything the sandbox is allowed to reach: the estate, and npm. */
export const toolchainEgress = { allowed_hosts: ["github.com", "registry.npmjs.org"] };

/** The runtime the setup script installs chant with. */
export const toolchainPackages = { node: "24" };

// The computer the steward operates this environment from. It needs three
// things and nothing else: the estate repo, a chant to run, and egress narrow
// enough that FTN010's "say what you meant" is answered honestly.
//
// repoUrl is a build parameter (declared in chant.config.ts), not a
// process.env read, so the manifest this synthesizes is a function of the
// build invocation rather than of whatever shell ran it.
export const toolchain = new Environment({
  name: "prod-toolchain",
  repositories: [
    new Repository({
      url: params.repoUrl as string,
      mount_path: "/workspace/estate",
      ref: "main",
    }),
  ],
  setup_script: "npm ci && npm install -g @intentius/chant",
  networking_type: "limited",
  networking_config: toolchainEgress,
  packages: toolchainPackages,
  metadata: chantOwned,
});

// A placeholder. Put the credentials the ops actually need behind it — one
// vault per environment, so a steward can only ever attach its own. Values are
// set in fountain, never here. Under an egress broker, drop this and the
// \`vault:\` line below: the broker holds the credentials and the sandbox never
// sees one.
export const prodCreds = new Vault({
  name: "prod-creds",
  description: "Credentials the prod ops run with. Set the values in fountain.",
  metadata: chantOwned,
});

// One writer for this environment. Every run of either op lands on this
// teammate's thread, so the thread is the environment's operational history.
export const { agent, teammate, schedules } = Steward({
  name: "prod-steward",
  environment: toolchain,
  vault: prodCreds,
  ops: [prodWatch, prodConverge],
});
`;

const STEWARD_CONFIG = `import type { ChantConfig } from "@intentius/chant/config";
// Brings the \`fountain\` key into ChantConfig. Type-only on purpose: a value
// import here would pull the whole lexicon package into every read of this
// config, including the bundle \`chant build --sandbox\` makes of it.
import type {} from "@intentius/chant-lexicon-fountain";

export default {
  lexicons: ["fountain"],
  buildParams: {
    // The estate repo the steward's sandbox clones. Pass it with
    // \`chant build --param repoUrl=...\`, or give it a default here.
    repoUrl: { type: "string", default: "https://github.com/acme/estate" },
  },
  fountain: {
    profiles: {
      prod: {
        endpoint: "https://fountain.inevitable.fyi",
        // Always a variable name, never a literal — FTN001 refuses the literal.
        token: { env: "FOUNTAIN_TOKEN" },
        // The teammate \`chant run <op> --on fountain\` posts to when the op
        // is not listed on a Steward this process loaded.
        team: "prod-steward",
      },
    },
    defaultProfile: "prod",
  },
} satisfies ChantConfig;
`;

export function fountainInitTemplates(template?: string): InitTemplateSet {
  if (template === "open") {
    return { src: { "fountain.ts": OPEN } };
  }
  if (template === "steward") {
    return {
      src: {
        "fountain.ts": STEWARD,
        "prod-watch.op.ts": STEWARD_WATCH_OP,
        "prod-converge.op.ts": STEWARD_CONVERGE_OP,
      },
      root: { "chant.config.ts": STEWARD_CONFIG },
    };
  }
  return { src: { "fountain.ts": CONCIERGE } };
}
