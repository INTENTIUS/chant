import { Composite, mergeDefaults } from "@intentius/chant";
import { Job, Step, Permissions } from "../generated/index";
import { Checkout } from "./checkout";
import { SetupNode } from "./setup-node";

export interface PrPlanReportProps {
  /**
   * Lifecycle environment to plan against — the `<environment>` argument of
   * `chant lifecycle plan`.
   */
  environment: string;
  /** Restrict the plan to one lexicon (the optional `[lexicon]` argument). */
  lexicon?: string;
  /** Plan against chant-owned resources only (passes `--owned`). */
  ownedOnly?: boolean;
  /** Runner label. Default: `"ubuntu-latest"` */
  runsOn?: string;
  /** Node.js version for chant's own toolchain. Default: `"22"` */
  nodeVersion?: string;
  /** Install command, run after checkout. Default: `"npm ci"` */
  installCommand?: string;
  /**
   * Commands to run before the plan — typically cloud-credential setup, since
   * the plan queries the live system to classify create/update/delete.
   */
  before?: string[];
  /**
   * Post the plan as a sticky PR comment. Default: `true` — the point of this
   * composite is that the compiled diff reaches the reviewer without being
   * asked for, so the manual step it replaces stops being skippable because
   * it stops being manual. Set `false` to run the plan without posting —
   * the explicit opt-out.
   */
  postComment?: boolean;
  /**
   * Hidden marker that makes the comment findable across pushes. Defaults to
   * one keyed on `environment`, so a repo planning two environments gets two
   * comments and each updates in place; override only to share one comment
   * across environments.
   */
  marker?: string;
  /** Per-member defaults for customizing the generated job. */
  defaults?: {
    job?: Partial<ConstructorParameters<typeof Job>[0]>;
  };
}

/**
 * Sticky-comment script (#1223's mechanism, reused as-is): find the comment
 * whose body starts with `$MARKER`, PATCH it if found, POST otherwise. No
 * marketplace action, nothing extra to pin — `gh` ships on GitHub's hosted
 * runners. `-f body=@plan.md` reads the comment body from the file the plan
 * step wrote, so a large or multi-line plan never has to survive shell
 * quoting.
 */
const stickyCommentScript = [
  'comment_id=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate ' +
    '--jq "map(select(.body | startswith(\\"$MARKER\\"))) | .[0].id // empty")',
  'if [ -n "$comment_id" ]; then',
  '  gh api -X PATCH "repos/$REPO/issues/comments/$comment_id" -f body=@plan.md > /dev/null',
  "else",
  '  gh api -X POST "repos/$REPO/issues/$PR_NUMBER/comments" -f body=@plan.md > /dev/null',
  "fi",
].join("\n");

/**
 * A CI job that builds, plans, and posts `chant lifecycle plan --report
 * markdown` as a sticky PR comment (#1983) — the compiled diff reaches the
 * reviewer without being asked for.
 *
 * A sibling of the gitlab lexicon's `MrPlanReport`, but where GitLab renders
 * a native merge-request widget from a counts artifact, GitHub has no such
 * widget: the mechanism is the sticky-comment recipe `examples/github-pr-preview`
 * proved (#1223), reused here rather than reinvented. The forgejo lexicon
 * inherits this composite through its github re-export, since Forgejo Actions
 * runs the same workflow shape and the Forgejo API accepts the same `gh api`
 * calls against its GitHub-compatible surface.
 *
 * Only meaningful on a `pull_request`-triggered workflow — the job guards on
 * `github.event_name` since the comment targets `github.event.number`, which
 * a push-triggered run does not have. The plan reads the live system, so wire
 * cloud credentials via `before` or CI variables.
 */
export const PrPlanReport = Composite((props: PrPlanReportProps) => {
  const {
    environment,
    lexicon,
    ownedOnly = false,
    runsOn = "ubuntu-latest",
    nodeVersion = "22",
    installCommand = "npm ci",
    before,
    postComment = true,
    marker = `<!-- chant-pr-plan-report:${environment} -->`,
    defaults: defs,
  } = props;

  const planArgs = [
    "lifecycle",
    "plan",
    environment,
    ...(lexicon ? [lexicon] : []),
    ...(ownedOnly ? ["--owned"] : []),
    "--report",
    "markdown",
  ].join(" ");

  const steps = [
    Checkout({}).step,
    SetupNode({ nodeVersion, cache: "npm" }).step,
    new Step({ name: "Install", run: installCommand }),
    ...(before ?? []).map((cmd) => new Step({ name: "Live credentials", run: cmd })),
    new Step({ name: "Build", run: "npx chant build" }),
    new Step({
      name: `Plan ${environment}`,
      // The marker (and an "updated for" footer, same spirit as the preview
      // tutorial's) is prepended to the rendered plan before anything is
      // posted, so the comment body itself carries the identity the search
      // step below keys on.
      run: [
        `npx chant ${planArgs} > plan-body.md`,
        '{ printf \'%s\\n\\n\' "$MARKER"; printf \'_Updated for %s._\\n\\n\' "$HEAD_SHA"; cat plan-body.md; } > plan.md',
      ].join("\n"),
    }),
    ...(postComment
      ? [
          new Step({
            name: "Post or update PR comment",
            env: { GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
            run: stickyCommentScript,
          }),
        ]
      : []),
  ];

  const job = new Job(mergeDefaults({
    "runs-on": runsOn,
    if: "github.event_name == 'pull_request'",
    permissions: new Permissions({ contents: "read", "pull-requests": "write" }),
    env: {
      MARKER: marker,
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      PR_NUMBER: "${{ github.event.number }}",
      REPO: "${{ github.repository }}",
    },
    steps,
  }, defs?.job));

  return { job };
}, "PrPlanReport");
