import { describe, expect, it } from "vitest";
import { SubrequestBudget } from "../src/util/budget";

describe("subrequest budget", () => {
  it("tracks charges and remaining", () => {
    const b = new SubrequestBudget(10);
    expect(b.canAfford(5)).toBe(true);
    expect(b.charge(5)).toBe(true);
    expect(b.remaining()).toBe(5);
    expect(b.charge(6)).toBe(false);
    expect(b.used).toBe(5);
  });

  it("force charge exceeds limit for priority work", () => {
    const b = new SubrequestBudget(2);
    expect(b.charge(2)).toBe(true);
    expect(b.charge(1)).toBe(false);
    expect(b.charge(1, { force: true })).toBe(true);
    expect(b.used).toBe(3);
  });

  it("defers heavy work when remaining < 5", () => {
    const b = new SubrequestBudget(10);
    b.charge(6);
    expect(b.shouldDeferHeavy()).toBe(true);
    const ok = new SubrequestBudget(10);
    ok.charge(4);
    expect(ok.shouldDeferHeavy()).toBe(false);
  });
});
