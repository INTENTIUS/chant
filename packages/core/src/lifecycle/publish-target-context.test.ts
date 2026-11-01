/**
 * #4602: the publish-target contract takes its context as a type parameter.
 * A target outside `release.publish` builds over its own context, which
 * extends `PublishContextBase`, with its own `kind` names, and reuses core's
 * error class, fetch and redactor. The release targets keep the default:
 * `PublishContext` and the three kinds `createPublishTargets` makes.
 *
 * The assertions are on types; the one runtime check drives the toy target
 * against an in-memory fetch, so nothing is sent anywhere.
 */

import { describe, expect, expectTypeOf, test } from "vitest";
import { createRedactor } from "./publish-credentials";
import { createPublishTargets } from "./publish-targets";
import {
  PublishTargetError,
  type PublishContext,
  type PublishContextBase,
  type PublishFetch,
  type PublishTarget,
  type ReleasePublishKind,
  type StagedTarget,
} from "./release-publish";

/** A module version, as the terraform lexicon's module targets take it. */
interface ToyModuleContext extends PublishContextBase {
  address: string;
  version: string;
  archive: Uint8Array;
}

function toyTarget(fetch: PublishFetch): PublishTarget<ToyModuleContext, "toy-registry"> {
  const url = (ctx: ToyModuleContext) => `http://127.0.0.1/${ctx.address}/${ctx.version}`;
  return {
    kind: "toy-registry",
    name: "toy registry",
    destination: "http://127.0.0.1",
    credentialEnv: ["TOY_TOKEN"],
    key: "toy-registry:0",
    async plan(ctx) {
      if (!ctx.env.TOY_TOKEN) throw new PublishTargetError("publish-credentials-missing", "TOY_TOKEN is not set");
      ctx.redactor.add(ctx.env.TOY_TOKEN);
      return [{ name: `${ctx.address}@${ctx.version}`, destination: url(ctx) }];
    },
    async stage(ctx) {
      const res = await fetch(url(ctx), { method: "PUT", headers: { Authorization: `Bearer ${ctx.env.TOY_TOKEN}` }, body: ctx.archive });
      if (!res.ok) throw new PublishTargetError("publish-upload-failed", ctx.redactor.redact(`upload answered ${res.status}`));
      ctx.log(`uploaded ${ctx.address}@${ctx.version}`);
      return { target: "toy registry", destination: url(ctx), items: [{ name: `${ctx.address}@${ctx.version}`, destination: url(ctx) }], state: {} };
    },
    async reveal(_ctx, staged: StagedTarget) {
      return { target: staged.target, destination: staged.destination, items: staged.items };
    },
  };
}

describe("publish target context (#4602)", () => {
  test("a target over a module-version context has its own context and kind", () => {
    type Toy = ReturnType<typeof toyTarget>;
    expectTypeOf<Toy["kind"]>().toEqualTypeOf<"toy-registry">();
    expectTypeOf<Parameters<Toy["plan"]>[0]>().toEqualTypeOf<ToyModuleContext>();
    expectTypeOf<Parameters<Toy["reveal"]>[0]>().toEqualTypeOf<ToyModuleContext>();
    // The base holds no release field, so a module target never needs one.
    expectTypeOf<PublishContextBase>().not.toHaveProperty("release");
    expectTypeOf<ToyModuleContext>().toMatchTypeOf<PublishContextBase>();
  });

  test("the release targets keep the default context and their kinds", () => {
    expectTypeOf<PublishTarget["kind"]>().toEqualTypeOf<ReleasePublishKind>();
    expectTypeOf<ReleasePublishKind>().toEqualTypeOf<"npm" | "oci" | "forge" | "homebrew" | "marketplace" | "tauri-updater">();
    expectTypeOf<Parameters<PublishTarget["plan"]>[0]>().toEqualTypeOf<PublishContext>();
    expectTypeOf<PublishContext>().toMatchTypeOf<PublishContextBase>();
    expectTypeOf<Awaited<ReturnType<typeof createPublishTargets>>>().toEqualTypeOf<PublishTarget[]>();
  });

  test("a module target is not a release target", () => {
    type Toy = ReturnType<typeof toyTarget>;
    expectTypeOf<Toy>().not.toMatchTypeOf<PublishTarget>();
  });

  test("the toy target stages through the injected fetch and masks its token", async () => {
    const sent: { url: string; headers: Record<string, string> }[] = [];
    const fetch: PublishFetch = async (url, init) => {
      sent.push({ url, headers: init.headers });
      return { ok: false, status: 403, headers: { get: () => null }, text: async () => "" };
    };
    const lines: string[] = [];
    const redactor = createRedactor({});
    const ctx: ToyModuleContext = {
      cwd: "/nowhere",
      env: { TOY_TOKEN: "toy-secret-value" },
      redactor,
      log: (line) => lines.push(redactor.redact(line)),
      provenance: { oidc: false, ci: null, reason: "not in CI" },
      tag: null,
      address: "acme/vpc/aws",
      version: "1.2.0",
      archive: new Uint8Array([1, 2, 3]),
    };
    const target = toyTarget(fetch);
    await target.plan(ctx);
    const err = await target.stage(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishTargetError);
    expect((err as PublishTargetError).code).toBe("publish-upload-failed");
    expect(sent[0]!.url).toBe("http://127.0.0.1/acme/vpc/aws/1.2.0");
    expect(redactor.redact(`Bearer ${ctx.env.TOY_TOKEN}`)).not.toContain("toy-secret-value");
  });
});
