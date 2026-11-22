/** #5457: which FROM lines of a Dockerfile are not pinned by digest. */
import { describe, expect, test } from "vitest";
import { dockerfileInstructions, fromImage, unpinnedFroms } from "./dockerfile-pins";

const D = `sha256:${"c".repeat(64)}`;

describe("unpinnedFroms", () => {
  test("a base named by tag is reported, and passes once pinned", () => {
    expect(unpinnedFroms("FROM node:22\nRUN true\n")).toEqual([{ line: 1, image: "node:22", why: "node:22 is named by tag, not pinned by digest (name:tag@sha256:<digest>)" }]);
    expect(unpinnedFroms(`FROM node:22@${D}\nRUN true\n`)).toEqual([]);
    expect(unpinnedFroms(`FROM --platform=$BUILDPLATFORM node@${D} AS build\n`)).toEqual([]);
  });

  test("an earlier stage and scratch pass; a stage named before it is defined does not", () => {
    expect(unpinnedFroms(`FROM golang:1.23@${D} AS build\nRUN go build\nFROM scratch\nCOPY --from=build /a /a\n`)).toEqual([]);
    expect(unpinnedFroms(`FROM node:22@${D} AS base\nFROM base AS test\nFROM test\n`)).toEqual([]);
    expect(unpinnedFroms("FROM later\nFROM node AS later\n").map((u) => u.image)).toEqual(["later", "node"]);
  });

  test("an ARG before the first FROM passes with a pinned default, and a build argument replaces it", () => {
    const text = `# base image\nARG BASE=node:22@${D}\nFROM \${BASE}\n`;
    expect(unpinnedFroms(text)).toEqual([]);
    expect(unpinnedFroms(text, { BASE: "node:22" })).toEqual([{ line: 3, image: "${BASE}", resolved: "node:22", why: "node:22 is named by tag, not pinned by digest (name:tag@sha256:<digest>)" }]);
    expect(unpinnedFroms("ARG BASE\nFROM $BASE\n")[0]!.why).toContain("build argument BASE, which has no default");
    expect(unpinnedFroms(`FROM \${BASE:-node:22@${D}}\n`)).toEqual([]);
  });

  test("continuations and comments are read as Docker reads them, with the line the instruction starts on", () => {
    const text = "# syntax=docker/dockerfile:1\n\nFROM \\\n  node:22 \\\n  AS app\nRUN true\n";
    expect(dockerfileInstructions(text).map((i) => ({ ...i, value: i.value.replace(/\s+/g, " ") }))).toEqual([
      { keyword: "FROM", value: "node:22 AS app", line: 3 },
      { keyword: "RUN", value: "true", line: 6 },
    ]);
    expect(fromImage("--platform=linux/amd64 node:22 as app")).toEqual({ image: "node:22", as: "app" });
    expect(unpinnedFroms(text).map((u) => u.line)).toEqual([3]);
  });
});
