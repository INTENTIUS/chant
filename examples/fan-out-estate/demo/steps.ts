/**
 * The words of the fan-out demo (#4091): the title, the four chapters, a
 * label for every step, the about cards, the highlights and the holds. The
 * driver (driver.ts, cycle.ts) decides when a step is written; this file says
 * what it says. Ported from the fan-out scenario of the driver behold's kiosk
 * read before this one, with the same chapters, labels, cards and holds.
 */
import type { DemoChapter, DemoStepName } from "./schemas/index.js";

/** Names shared by the stack, the driver and the readers. Chant's only. */
export const DEMO = "fan-out-estate";
export const SCENARIO = "fan-out";
export const NAME = "fifteen stacks";
export const ORG = "chant-demo";
export const REPO_NAME = "fan-out-estate";
export const REPO = `${ORG}/${REPO_NAME}`;
export const BUCKET = "chant-demo";
/** Below the bucket: step.json, cycles/ and reports/. */
export const PREFIX = "fan-out-estate";
/** The `--report-url` the generated workflow uploads to. */
export const REPORT_URL = `s3://${BUCKET}/${PREFIX}/reports`;
export const AUTHOR = "author";
export const REVIEWER = "reviewer";
/** The forge host chant names reviewers by: Forgejo's ROOT_URL in the stack. */
export const FORGE_HOST = "forgejo:3000";

export const TITLE = "A broken stack shouldn't stall the whole rollout";

/** One pull request of the cycle: the change, then the fix. */
export type Round = "change" | "fix";

/** The about cards a step carries. */
export interface About {
  changes: string;
  watch: string;
  shows: string;
}

/** A callout a viewer shows at three beats of the cycle. null at every other step. */
export interface Highlight {
  title: string;
  body: string;
}

export const ABOUT: Record<Round, About> = {
  change: {
    changes:
      "A pull request (a change up for review) edits the shared network. It also adds a cluster-a queue whose name AWS refuses.",
    watch:
      "chant plans fifteen stacks in three waves. After the merge, network applies first. Then cluster-a fails and its six apps are blocked. Cluster-b's six apps go ahead. A fix applies the seven left.",
    shows: "A failure blocks only the stacks that depend on it, and the fix applies only what was left.",
  },
  fix: {
    changes: "The fix gives the queue a name that ends in .fifo. It touches cluster-a and its six apps, nothing else.",
    watch:
      "chant plans only those seven stacks. A reviewer approves the fix. The merge applies cluster-a first and its six apps after it.",
    shows: "A failure blocks only the stacks that depend on it, and the fix applies only what was left.",
  },
};

const HEADLINES = [
  "A change to the shared network goes out to all 15 stacks",
  "cluster-a breaks. Only its 6 apps stop; the other 8 stacks ship anyway",
  "The fix re-runs only the 7 that were blocked",
  "All 15 are in, and nothing was applied twice",
] as const;

const SHORT = ["The change goes out", "cluster-a breaks", "The fix", "Done"] as const;

/** Chapter n of four. */
export function chapterOf(n: 1 | 2 | 3 | 4): DemoChapter {
  return { n, of: 4, headline: HEADLINES[n - 1], short: SHORT[n - 1] };
}

/** The chapter a step of a round belongs to, or null (the base, a reset after a stall). */
export function chapterFor(round: Round | null, step: DemoStepName): DemoChapter | null {
  if (round === null) return null;
  if (round === "change") {
    if (step === "failed") return chapterOf(2);
    return ["pull-request", "planned", "waiting", "approved", "merged", "applying"].includes(step) ? chapterOf(1) : null;
  }
  if (step === "applied" || step === "reset") return chapterOf(4);
  return ["pull-request", "planned", "waiting", "approved", "merged", "applying"].includes(step) ? chapterOf(3) : null;
}

/** A highlight's title and body are at most this long. */
export const HIGHLIGHT_LIMITS = { title: 60, body: 300 } as const;

/**
 * The three beats that carry a highlight. Every other step writes null, and
 * every write of one step carries the same object, since a viewer opens a
 * highlight once per cycle, step and title.
 */
export const HIGHLIGHTS = {
  plan: {
    title: "chant runs the whole rollout",
    body: "chant's own pull-request pipeline planned fifteen stacks in three waves and worked out which wait on which. The forge only started it.",
  },
  failed: {
    title: "A failure stops only what depends on it",
    body: "cluster-a failed, so its six apps are blocked. Network, cluster-b and cluster-b's six apps applied anyway, and the rollout did not stall.",
  },
  fix: {
    title: "The fix applies only the seven",
    body: "The fix runs cluster-a and app-01 to app-06, the seven that cluster-a's failure blocked. The eight that already applied are left alone.",
  },
} as const satisfies Record<string, Highlight>;

/** The highlight of a step, or null. */
export function highlightFor(round: Round | null, step: DemoStepName): Highlight | null {
  if (round === "change" && step === "planned") return HIGHLIGHTS.plan;
  if (round === "change" && step === "failed") return HIGHLIGHTS.failed;
  if (round === "fix" && step === "applying") return HIGHLIGHTS.fix;
  return null;
}

/** What a label may name. */
export interface LabelContext {
  cycle: number;
  pull?: number | null;
  commit?: string;
}

const short = (sha?: string): string => (sha ? sha.slice(0, 8) : "");

/** The label of a step in a round. */
export function labelFor(round: Round, step: DemoStepName, ctx: LabelContext): string {
  const pull = ctx.pull ?? "";
  if (round === "change") {
    switch (step) {
      case "pull-request":
        return `Pull request ${pull} is open. Network's topic gets a new display name, and cluster-a gains a FIFO queue whose name lacks .fifo.`;
      case "planned":
        return "The plan covers fifteen stacks in three waves: network, then cluster-a and cluster-b, then twelve apps.";
      case "waiting":
        return "The plan waits for a reviewer's approval.";
      case "approved":
        return "The driver approves the pull request and its digest as the reviewer, who had no hand in the change.";
      case "applying":
        return "Network applies in wave 1. Cluster-a and cluster-b apply side by side in wave 2, and each one's six apps follow in wave 3.";
      case "failed":
        return "cluster-a failed because SQS refuses a FIFO queue whose name lacks .fifo. Its six apps are blocked; cluster-b's six went ahead.";
      default:
        break;
    }
  } else {
    switch (step) {
      case "pull-request":
        return `The fix is pull request ${pull}: the queue's name now ends in .fifo. It reaches cluster-a and its six apps, and nothing else.`;
      case "planned":
        return "The fix's plan covers seven stacks: cluster-a, then app-01 to app-06. Network, cluster-b and its apps stay as they applied.";
      case "waiting":
        return "The fix's plan waits for a reviewer's approval.";
      case "approved":
        return "The driver approves the fix and its digest as the reviewer.";
      case "applying":
        return "The merge applies the plan the reviewer approved: cluster-a first, then its six apps.";
      case "applied":
        return "All fifteen stacks are in. The first run applied eight. The fix applied the seven that cluster-a's failure blocked.";
      default:
        break;
    }
  }
  if (step === "merged") {
    return `Pull request ${pull} is merged into main (the branch the pipeline applies) at ${short(ctx.commit)}, and the pipeline starts.`;
  }
  if (step === "reset") return resetLabel(ctx.commit);
  return step;
}

export const BASE_LABEL =
  "The base is applied: fifteen CloudFormation stacks. Network, then cluster-a and cluster-b on it, and six apps on each cluster.";

export function resetLabel(base?: string): string {
  return `Outside the pipeline, the driver applies the base to every stack again. It also moves main back to ${short(base)} for the next cycle.`;
}

export function stalledLabel(after: string, reason: string): string {
  return `Stalled after ${after}: ${reason}. The driver resets and goes on with the next cycle.`;
}

/** The next action each step names. */
export const NEXT: Partial<Record<DemoStepName, string>> = {
  "pull-request": "wait for the plan",
  planned: "ask for a review",
  waiting: "approve the plan's digest",
  approved: "merge the pull request",
  merged: "follow the waves",
  applying: "follow the apply",
  failed: "open the fix",
  applied: "reset",
  reset: "start the next cycle",
};

/** The pull request titles. */
export const PULL_TITLE: Record<Round, string> = {
  change: TITLE,
  fix: "cluster-a: the events queue's name ends in .fifo",
};

/** The branch a round pushes. */
export const branchFor = (round: Round, cycle: number): string => `demo/${round}-${cycle}`;

/**
 * How long a step is held so a viewer reads it, in seconds. Trimmed from the
 * old driver's 12, 12, 4, 8, 20 and 18 toward a cycle of about 2.5 minutes.
 * The failed step holds longest: it is where the story turns.
 */
export const HOLDS = {
  planned: 8,
  waiting: 6,
  fixPlanned: 4,
  fixWaiting: 6,
  failed: 15,
  end: 15,
} as const;

export type HoldName = keyof typeof HOLDS;

/** Each step's time limit, in seconds. Past it the driver writes stalled and resets. */
export const LIMITS = {
  /** The pull request push and open. */
  open: 60,
  /** pr-plan.json at the head, from the push. */
  plan: 600,
  /** The forge review and chant approve. */
  approve: 120,
  /** The merge and its merge commit. */
  merge: 60,
  /** pr-apply.json at the merge commit, from the merge. */
  apply: 900,
  /** The reset's out-of-band work. */
  reset: 600,
} as const;

export type LimitName = keyof typeof LIMITS;

/** The fifteen components, by wave. */
export const WAVES = [
  ["network"],
  ["cluster-a", "cluster-b"],
  ["app-01", "app-02", "app-03", "app-04", "app-05", "app-06", "app-07", "app-08", "app-09", "app-10", "app-11", "app-12"],
] as const;

/** What cluster-a's failure blocks. */
export const HELD = ["app-01", "app-02", "app-03", "app-04", "app-05", "app-06"] as const;
/** What applies beside cluster-a's failure. */
export const WENT = ["network", "cluster-b", "app-07", "app-08", "app-09", "app-10", "app-11", "app-12"] as const;
/** What the fix plans and applies. */
export const FIXED = ["cluster-a", ...HELD] as const;
