// chant#4605: the zip of an attested module archive keeps every file, path and mode, is the
// same bytes every time, and names the attested content in its archive comment.
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PublishTargetError } from "@intentius/chant/lifecycle/release-publish";
import { archiveContent, contentDigest, heldContentOf, moduleArchiveEntries, moduleZip, readModuleZipComment, readZip } from "../index";
import { moduleTarball } from "./fake-http";

const FILES = {
  "main.tf": 'resource "null_resource" "a" {}\n',
  "variables.tf": 'variable "cidr" {}\n',
  "modules/sub/main.tf": "# sub\n",
  "README.md": "# vpc\n",
};

describe("module zip (chant#4605)", () => {
  it("carries every file of the tarball at its path with its bytes", () => {
    const archive = moduleTarball(FILES);
    const zip = readZip(moduleZip(archive, archiveContent(archive)));
    const files = Object.fromEntries(zip.entries.filter((e) => !e.dir).map((e) => [e.path, e.data.toString("utf-8")]));
    expect(files).toEqual(FILES);
    expect(zip.entries.filter((e) => e.dir).map((e) => e.path)).toEqual(["modules", "modules/sub"]);
    expect(zip.entries.find((e) => e.path === "main.tf")!.mode).toBe(0o644);
  });

  it("gives the same bytes for the same archive", () => {
    const archive = moduleTarball(FILES);
    const content = archiveContent(archive);
    expect(Buffer.compare(moduleZip(archive, content, "abc"), moduleZip(archive, content, "abc"))).toBe(0);
  });

  it("names the attested content and revision in the archive comment", () => {
    const archive = moduleTarball(FILES);
    const content = archiveContent(archive);
    const zip = moduleZip(archive, content, "3f2a9c1d");
    expect(readModuleZipComment(readZip(zip).comment)).toEqual({ content, revision: "3f2a9c1d" });
    expect(heldContentOf(zip, contentDigest)).toEqual({ content, revision: "3f2a9c1d" });
  });

  it("judges a gzip tarball by its uncompressed bytes and any other bytes by their own digest", () => {
    const archive = moduleTarball(FILES);
    expect(heldContentOf(archive, contentDigest).content).toBe(archiveContent(archive));
    const plain = Buffer.from("not an archive");
    expect(heldContentOf(plain, contentDigest).content).toBe(contentDigest(plain));
  });

  it("cuts ./ from paths", () => {
    const entries = moduleArchiveEntries(moduleTarball({ "./main.tf": "x" }));
    expect(entries.map((e) => e.path)).toEqual(["main.tf"]);
  });

  it("refuses bytes that are not a gzip tarball", () => {
    expect(() => moduleArchiveEntries(Buffer.from("plain"))).toThrow(PublishTargetError);
  });

  it("refuses a path outside the archive's root", () => {
    const header = Buffer.alloc(512);
    header.write("../evil.tf", 0);
    header.write("0000644\0", 100);
    header.write("00000000000\0", 124);
    header.write("0", 156);
    const tar = gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
    expect(() => moduleArchiveEntries(tar)).toThrow(/outside its root/);
  });
});
