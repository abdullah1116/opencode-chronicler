import type { SessionSummary } from "../domain/types";
import { formatNumber } from "./format";

const EMPTY_TABLE = "No sessions found.";

export const SESSIONS_TABLE_HEAD_CHARS = 140;
export const SESSIONS_TABLE_FOOTER_RESERVE_CHARS = 160;

export interface SessionsTableOptions {
  totalRows?: number;
  estimatedTokens?: number;
  tokenBudget?: number;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function cell(value: string | null): string {
  return value === null ? "\u2014" : escapeCell(value);
}

function previewCell(value: string | null): string {
  if (value === null) return "";
  return escapeCell(value).slice(0, 80);
}

export function renderSessionRow(summary: SessionSummary): string {
  const cells = [
    escapeCell(summary.id),
    cell(summary.title),
    String(summary.messageCount),
    cell(summary.updatedAt),
    cell(summary.directory),
    previewCell(summary.preview),
  ];
  return `| ${cells.join(" | ")} |`;
}

export function renderSessionsTable(
  summaries: SessionSummary[],
  options?: SessionsTableOptions,
): string {
  if (summaries.length === 0) return EMPTY_TABLE;

  const lines = [
    "| ID | Title | Msgs | Updated | Directory | Preview |",
    "|---|---|---|---|---|---|",
    ...summaries.map(renderSessionRow),
  ];

  const totalRows = options?.totalRows;
  const omitted = totalRows === undefined ? 0 : Math.max(0, totalRows - summaries.length);
  if (omitted > 0) {
    lines.push(
      "",
      `_\u2026 ${formatNumber(omitted)} older sessions omitted \u2014 showing the newest ${formatNumber(summaries.length)} of ${formatNumber(totalRows!)}. \u2026_`,
    );
  }

  if (options?.estimatedTokens !== undefined && options?.tokenBudget !== undefined) {
    lines.push(
      "",
      `_\u2248${formatNumber(options.estimatedTokens)} of ${formatNumber(options.tokenBudget)} tokens used._`,
    );
  }

  return lines.join("\n");
}
