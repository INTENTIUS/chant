import { describe, expect, test } from "vitest";
import { npmCause } from "./npm-cause";

const POINTER = "npm error A complete log of this run can be found in: /home/u/.npm/_logs/x-debug-0.log";

describe("npmCause", () => {
  test("skips the log-file pointer", () => {
    expect(npmCause(["npm error found no dependencies to audit", POINTER])).toBe("found no dependencies to audit");
  });

  test("returns the code line with the line after it", () => {
    expect(npmCause(["npm error code E403", "npm error 403 Forbidden - GET https://x/pkg", "npm error more", POINTER])).toBe("code E403: 403 Forbidden - GET https://x/pkg");
  });

  test("understands the npm ERR! prefix", () => {
    expect(npmCause(["npm ERR! code E404", "npm ERR! 404 Not Found", "npm ERR! A complete log of this run can be found in: x"])).toBe("code E404: 404 Not Found");
  });

  test("reads multi-line chunks", () => {
    expect(npmCause([`npm error boom\n${POINTER}\n`])).toBe("boom");
  });

  test("falls back to the last line, then to the fallback", () => {
    expect(npmCause(["first", "second"])).toBe("second");
    expect(npmCause([])).toBe("npm printed nothing");
    expect(npmCause("", "no output")).toBe("no output");
  });
});
