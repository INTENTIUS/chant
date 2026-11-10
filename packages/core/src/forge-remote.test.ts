/**
 * #4920: the forge a checkout's origin remote names, public, so a laptop
 * command needs no repository setting.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { forgeKindOfHost, forgeOfCheckout, forgeOfRemote } from "./forge-remote";

describe("forgeOfRemote (#4920)", () => {
  test("https, ssh and scp remotes on each forge", () => {
    expect(forgeOfRemote("https://github.com/acme/infra.git")).toEqual({ kind: "github", host: "github.com", url: "https://github.com", repo: "acme/infra" });
    expect(forgeOfRemote("git@gitlab.com:group/sub/proj.git")).toEqual({ kind: "gitlab", host: "gitlab.com", url: "https://gitlab.com", repo: "group/sub/proj" });
    expect(forgeOfRemote("ssh://git@codeberg.org:22/acme/infra")).toEqual({ kind: "forgejo", host: "codeberg.org", url: "https://codeberg.org", repo: "acme/infra" });
    expect(forgeOfRemote("http://forgejo.lan:3000/acme/infra.git")).toEqual({ kind: "forgejo", host: "forgejo.lan:3000", url: "http://forgejo.lan:3000", repo: "acme/infra" });
  });

  test("a host no forge is named for, unless the kind is given; no repository path is none", () => {
    expect(forgeOfRemote("git@git.corp.example:acme/infra.git")).toBeUndefined();
    expect(forgeOfRemote("git@git.corp.example:acme/infra.git", { kind: "gitlab" })).toMatchObject({ kind: "gitlab", repo: "acme/infra", url: "https://git.corp.example" });
    expect(forgeOfRemote("https://github.com/")).toBeUndefined();
    expect(forgeOfRemote(undefined)).toBeUndefined();
    expect(forgeKindOfHost("GitHub.example.com")).toBe("github");
  });

  test("a checkout's origin, read with git", () => {
    // A temporary checkout, left for the OS to clear.
    const dir = mkdtempSync(join(tmpdir(), "chant-forge-remote-"));
    execFileSync("git", ["-C", dir, "init", "-q"]);
    expect(forgeOfCheckout(dir)).toBeUndefined();
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:acme/infra.git"]);
    expect(forgeOfCheckout(dir)).toMatchObject({ kind: "github", repo: "acme/infra" });
    expect(forgeOfCheckout(dir, { remote: "upstream" })).toBeUndefined();
  });
});
