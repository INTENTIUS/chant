/**
 * PUL015: the config says stock pulumi for a member on a plunge backend.
 *
 * `pulumi.member.engine` decides which binary runs the member's preview,
 * outputs and drift; with none set, `plywood.yml`'s engine, a `plunge`
 * `PULUMI_BACKEND_URL`, or a `backend.url` in `Pulumi.yaml` that
 * starts with `plunge` means plunge (`../../run.ts`, `pulumiMemberEngine`).
 * The config wins, so `engine: "pulumi"` on a program whose backend is
 * `plunge+file://...` or `plunge://...` runs stock `pulumi` against a
 * backend scheme only plunge opens, and every read fails.
 *
 * One direction only, by maintainer ruling (#4559): `engine: "plunge"` with a
 * stock backend is not reported, because plunge opens stock backends and the
 * config may mean it.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { pulumiMemberEngine } from "../../run";
import { lastMemberRead } from "../../workspace-member";
import { finding } from "./member-read-helpers";

export const pul015: PostSynthCheck = {
  id: "PUL015",
  description: "pulumi.member.engine says pulumi, but the resolved engine is plunge",

  check(_ctx: PostSynthContext): PostSynthDiagnostic[] {
    const read = lastMemberRead();
    if (read?.engine !== "pulumi") return [];
    const implied = pulumiMemberEngine(read.dir);
    if (implied.engine !== "plunge") return [];
    return [
      finding(
        "PUL015",
        "warning",
        `pulumi.member.engine is "pulumi", but ${implied.because}. chant runs the configured engine, so the member's ` +
          `preview, outputs and drift run stock pulumi against a backend only plunge opens. Drop \`engine\` or set it to "plunge".`,
      ),
    ];
  },
};
