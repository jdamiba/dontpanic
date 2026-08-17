import { describe, it, expect } from "vitest";
import { findIssue } from "./context.js";

describe("findIssue", () => {
  it("finds a real issue key", () => {
    expect(findIssue("Fixes ENG-1234 in the reducer")).toBe("ENG-1234");
    expect(findIssue("ENG-462: experiment versions")).toBe("ENG-462");
    expect(findIssue("implements PROJ-590")).toBe("PROJ-590");
  });

  it("does not match encoding/standard tokens (the UTF-8 bug)", () => {
    expect(findIssue("we decode as UTF-8 here")).toBeNull();
    expect(findIssue("verify the SHA-256 digest")).toBeNull();
    expect(findIssue("per RFC-822 formatting")).toBeNull();
  });

  it("skips a denied prefix but still finds a later real key", () => {
    expect(findIssue("UTF-8 payload for PROJ-1053")).toBe("PROJ-1053");
  });

  it("returns null when there is no key", () => {
    expect(findIssue("just some prose, no ticket")).toBeNull();
  });
});
