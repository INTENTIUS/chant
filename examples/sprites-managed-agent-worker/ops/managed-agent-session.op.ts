import { Op, phase } from "@intentius/chant-lexicon-temporal";
import {
  spriteCreate,
  spriteApplyNetworkPolicy,
  spriteTaskCreate,
  spriteWriteFile,
  spriteApplyServices,
  spriteExec,
  spriteTaskRelease,
  spriteDestroy,
} from "@intentius/chant-lexicon-fly";

/**
 * One Managed Agents session on a Sprite (sprites.dev).
 *
 * Anthropic runs the agent loop and model and queues work items; a worker on
 * your infra claims each item and spawns a per-session Sprite that executes the
 * tools. This Op is that per-session unit — the worker runs it once per claimed
 * work item, passing the session id as the sprite `name`. The Anthropic
 * work-queue side is faked for the tutorial (see the README); the Sprite side is
 * real and runs against the in-process emulator with no key.
 *
 * The session composes every Sprite config primitive in turn:
 *   Secure  — an egress allowlist so the sandbox reaches only Anthropic and the
 *             package registries (spriteApplyNetworkPolicy).
 *   Hold    — a keep-alive task so the Sprite will not pause mid-session
 *             (spriteTaskCreate; released in the happy path and in onFailure).
 *   Stage   — the runner env-contract written to a file, never process args
 *             (spriteWriteFile).
 *   Runner  — Anthropic's runner as a supervised service (spriteApplyServices).
 *   Run     — the session does its work; Release and Destroy tear it down.
 *
 * S3: point at the in-process fake (or a self-hosted emulator) with
 * `SPRITES_BASE_URL`; real Sprites also needs `SPRITES_API_TOKEN`.
 */
const SESSION = "agent-session-1";

export default Op({
  name: "managed-agent-session",
  overview: "Run one Managed Agents session in a per-session Sprite",
  taskQueue: "sprites",
  phases: [
    phase("Create", [spriteCreate({ name: SESSION, image: "sprites/base:latest" })]),
    phase("Secure", [
      spriteApplyNetworkPolicy({
        id: SESSION,
        rules: [
          { domain: "api.anthropic.com", action: "allow" },
          { domain: "*.pypi.org", action: "allow" },
          { domain: "*", action: "deny" },
        ],
      }),
    ]),
    phase("Hold", [spriteTaskCreate({ id: SESSION, name: "session", expire: "5m" })]),
    phase("Stage", [
      spriteWriteFile({
        id: SESSION,
        path: "/run/agent.env",
        mkdir: true,
        mode: "0600",
        content: [
          "ANTHROPIC_ENVIRONMENT_KEY=${ANTHROPIC_ENVIRONMENT_KEY}",
          "ANTHROPIC_SESSION_ID=agent-session-1",
          "ANTHROPIC_ENVIRONMENT_ID=${ANTHROPIC_ENVIRONMENT_ID}",
          "ANTHROPIC_BASE_URL=https://api.anthropic.com",
        ].join("\n"),
      }),
    ]),
    phase("Runner", [
      spriteApplyServices({
        id: SESSION,
        start: true,
        services: [
          {
            name: "agent-runner",
            // Sources the env-contract file, then runs Anthropic's provider-agnostic
            // runner. In the emulator this is a no-op command.
            cmd: "sh",
            args: ["-c", "set -a; . /run/agent.env; exec agent-runner"],
            dir: "/run",
            http_port: 8080,
          },
        ],
      }),
    ]),
    // The session's tool calls run here. In the emulator, exercise the sandbox
    // with a trivial command; against real Sprites the runner service drives it.
    phase("Run", [spriteExec({ id: SESSION, cmd: "echo session-complete > /run/status" })]),
    phase("Release", [spriteTaskRelease({ id: SESSION, name: "session" })]),
    phase("Destroy", [spriteDestroy({ id: SESSION })]),
  ],
  // On failure, free the keep-alive hold and tear the Sprite down so a stuck
  // session never keeps a paused-but-billed sandbox alive.
  onFailure: [
    phase("Release", [spriteTaskRelease({ id: SESSION, name: "session" })]),
    phase("Destroy", [spriteDestroy({ id: SESSION })]),
  ],
});
