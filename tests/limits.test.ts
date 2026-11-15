import { describe, expect, test } from "bun:test";
import {
  boundaryPartChars,
  charsForBudget,
  clampTokenBudget,
  deriveRenderOptions,
  estimateTokens,
  partCharsForBudget,
  TOKEN_BUDGET_DEFAULTS,
  TOKEN_BUDGET_MAX,
  TOKEN_BUDGET_MIN,
} from "../src/limits";

describe("clampTokenBudget", () => {
  test("passes through in-range values and truncates fractions", () => {
    expect(clampTokenBudget(150_000, 1)).toBe(150_000);
    expect(clampTokenBudget(150_000.9, 1)).toBe(150_000);
  });

  test("clamps to the shared range", () => {
    expect(clampTokenBudget(1, 42)).toBe(TOKEN_BUDGET_MIN);
    expect(clampTokenBudget(-5, 42)).toBe(TOKEN_BUDGET_MIN);
    expect(clampTokenBudget(10_000_000, 42)).toBe(TOKEN_BUDGET_MAX);
  });

  test("falls back for non-numeric and non-finite input", () => {
    expect(clampTokenBudget(undefined, 42)).toBe(42);
    expect(clampTokenBudget(null, 42)).toBe(42);
    expect(clampTokenBudget("1000", 42)).toBe(42);
    expect(clampTokenBudget(Number.NaN, 42)).toBe(42);
    expect(clampTokenBudget(Number.POSITIVE_INFINITY, 42)).toBe(42);
  });
});

describe("estimateTokens / charsForBudget", () => {
  test("converts between chars and estimated tokens at the shared ratio", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(-10)).toBe(0);
    expect(estimateTokens(Number.NaN)).toBe(0);
    expect(estimateTokens(3.5)).toBe(1);
    expect(estimateTokens(350)).toBe(100);
    expect(charsForBudget(100)).toBe(350);
    expect(charsForBudget(0)).toBe(0);
  });
});

describe("derived render options", () => {
  test("per-part cap is 25% of the budget, floored at 500 and capped at 8000 tokens", () => {
    expect(partCharsForBudget(TOKEN_BUDGET_DEFAULTS.tail)).toBe(28_000);
    expect(partCharsForBudget(TOKEN_BUDGET_MIN)).toBe(1_750);
    expect(partCharsForBudget(TOKEN_BUDGET_MAX)).toBe(28_000);
  });

  test("deriveRenderOptions carries the include flag and the derived cap", () => {
    expect(deriveRenderOptions(150_000, false)).toEqual({
      includeToolOutput: false,
      maxPartChars: 28_000,
    });
  });

  test("boundary part chars never exceed the caller's part cap", () => {
    expect(boundaryPartChars(1_000, 1, 28_000)).toBe(2_750);
    expect(boundaryPartChars(1_000, 10, 28_000)).toBe(239);
    expect(boundaryPartChars(1_000, 10, 200)).toBe(200);
    expect(boundaryPartChars(1_000, 1_000, 28_000)).toBe(100);
  });
});
