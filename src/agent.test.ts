import { describe, it, expect } from "vitest";
import { extractReview } from "./agent.js";

describe("extractReview", () => {
  it("parses a bare JSON object", () => {
    const r = extractReview('{"verdict":"approve","summary":"lgtm","findings":[]}');
    expect(r?.verdict).toBe("approve");
    expect(r?.summary).toBe("lgtm");
    expect(r?.findings).toEqual([]);
  });

  it("parses JSON inside a ```json fence", () => {
    const r = extractReview('here you go:\n```json\n{"verdict":"request_changes","summary":"s","findings":[{"point":"p","file":"a.ts","line":3}]}\n```');
    expect(r?.verdict).toBe("request_changes");
    expect(r?.findings[0]).toEqual({ point: "p", file: "a.ts", line: 3 });
  });

  it("tolerates prose around the JSON", () => {
    const r = extractReview('My review: {"verdict":"comment","summary":"ok","findings":[]} — done.');
    expect(r?.verdict).toBe("comment");
  });

  it("returns null when there is no verdict JSON", () => {
    expect(extractReview("just prose, no structure")).toBeNull();
    expect(extractReview('{"notes":"missing verdict"}')).toBeNull();
  });
});
