import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateCostMicros, parseUsageBudgets, usagePeriodKeys } from "./modelUsage.js";

describe("model usage arithmetic", () => {
  it("uses integer micro-USD and keeps unknown prices unknown", () => {
    assert.equal(calculateCostMicros(1_000_000, 500_000, {
      inputMicrosPerMillion: 2_000_000,
      outputMicrosPerMillion: 6_000_000,
      currency: "USD"
    }), 5_000_000);
    assert.equal(calculateCostMicros(20, 40, null), null);
  });

  it("applies user time zones at day and month boundaries", () => {
    const instant = new Date("2026-01-01T00:30:00.000Z");
    assert.deepEqual(usagePeriodKeys(instant, "America/Los_Angeles"), { day: "2025-12-31", month: "2025-12" });
    assert.deepEqual(usagePeriodKeys(instant, "Asia/Hong_Kong"), { day: "2026-01-01", month: "2026-01" });
  });

  it("defaults every budget off and allows unknown pricing", () => {
    assert.deepEqual(parseUsageBudgets(null), {
      dailySoftMicros: null, dailyHardMicros: null,
      monthlySoftMicros: null, monthlyHardMicros: null,
      allowUnknownPricing: true
    });
  });
});
