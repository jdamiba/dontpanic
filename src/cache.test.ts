import { describe, it, expect, beforeEach } from "vitest";
import { cached, _clearMemory } from "./cache.js";

let n = 0;
const freshNs = () => `test-${Date.now()}-${n++}`;

describe("cached", () => {
  beforeEach(() => _clearMemory());

  it("dedupes concurrent calls — fn runs once", async () => {
    const ns = freshNs();
    let runs = 0;
    const fn = async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return "v"; };
    const [a, b] = await Promise.all([cached(ns, "k", 10000, fn), cached(ns, "k", 10000, fn)]);
    expect([a, b]).toEqual(["v", "v"]);
    expect(runs).toBe(1);
  });

  it("returns the cached value within TTL without re-running", async () => {
    const ns = freshNs();
    let runs = 0;
    const fn = async () => { runs++; return runs; };
    expect(await cached(ns, "k", 10000, fn)).toBe(1);
    expect(await cached(ns, "k", 10000, fn)).toBe(1);
    expect(runs).toBe(1);
  });

  it("re-runs after the TTL expires", async () => {
    const ns = freshNs();
    let runs = 0;
    const fn = async () => { runs++; return runs; };
    await cached(ns, "k", 5, fn);
    await new Promise((r) => setTimeout(r, 20));
    _clearMemory();
    expect(await cached(ns, "k", 5, fn)).toBe(2);
    expect(runs).toBe(2);
  });

  it("does not cache failures", async () => {
    const ns = freshNs();
    let runs = 0;
    const fn = async () => { runs++; if (runs === 1) throw new Error("boom"); return "ok"; };
    await expect(cached(ns, "k", 10000, fn)).rejects.toThrow("boom");
    expect(await cached(ns, "k", 10000, fn)).toBe("ok");
    expect(runs).toBe(2);
  });
});
