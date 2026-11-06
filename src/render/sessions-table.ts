import type { SessionSummary } from "../domain/types";

const EMPTY_TABLE = "No sessions found.";

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

export function renderSessionsTable(summaries: SessionSummary[]): string {
  if (summaries.length === 0) return EMPTY_TABLE;

  const rows = summaries.map((s) => {
    const cells = [
      escapeCell(s.id),
      cell(s.title),
      String(s.messageCount),
      cell(s.updatedAt),
      cell(s.directory),
      previewCell(s.preview),
    ];
    return `| ${cells.join(" | ")} |`;
  });

  return [
    "| ID | Title | Msgs | Updated | Directory | Preview |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}
