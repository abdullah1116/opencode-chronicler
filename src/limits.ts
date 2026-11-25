// The single limit type: a token budget on rendered output. Every tool clamps, derives, and reports through this module.
import type { RenderOptions } from "./domain/types";

export const CHARS_PER_TOKEN = 3.5;
export const TOKEN_BUDGET_MIN = 1_000;
export const TOKEN_BUDGET_MAX = 2_000_000;

export const TOKEN_BUDGET_DEFAULTS = {
  read: 150_000,
  tail: 150_000,
  list: 1_000,
} as const;

export const HEADER_RESERVE_CHARS = 600;
export const MIN_BODY_CHARS = 200;
export const PART_OVERHEAD_CHARS = 40;
export const PART_TOKEN_SHARE = 0.25;
export const PART_TOKEN_MIN = 500;
export const PART_TOKEN_MAX = 8_000;

export function clampTokenBudget(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), TOKEN_BUDGET_MIN), TOKEN_BUDGET_MAX);
}

export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function charsForBudget(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.floor(tokens * CHARS_PER_TOKEN);
}

export function bodyBudgetChars(tokenBudget: number): number {
  return Math.max(MIN_BODY_CHARS, charsForBudget(tokenBudget) - HEADER_RESERVE_CHARS);
}

export function partCharsForBudget(tokenBudget: number): number {
  const cap = Math.min(
    Math.max(Math.floor(tokenBudget * PART_TOKEN_SHARE), PART_TOKEN_MIN),
    PART_TOKEN_MAX,
  );
  return Math.floor(cap * CHARS_PER_TOKEN);
}

export function deriveRenderOptions(tokenBudget: number, includeToolOutput: boolean): RenderOptions {
  return { includeToolOutput, maxPartChars: partCharsForBudget(tokenBudget) };
}

export function boundaryPartChars(
  tokenBudget: number,
  partCount: number,
  partCap: number,
): number {
  const usable = Math.floor(bodyBudgetChars(tokenBudget) * 0.9);
  const perPart = Math.floor(usable / Math.max(1, partCount)) - PART_OVERHEAD_CHARS;
  return Math.max(100, Math.min(partCap, perPart));
}
