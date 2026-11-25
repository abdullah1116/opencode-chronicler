/** Domain contract between db/ and render/: extend additively; do not rename or reshape fields without updating both layers. */
export type MessageRole = "user" | "assistant" | "system";

export interface SessionMeta {
  id: string;
  title: string | null;
  directory: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  projectID: string | null;
  parentID: string | null;
  version: string | null;
}

export interface SessionSummary {
  id: string;
  title: string | null;
  directory: string | null;
  updatedAt: string | null;
  messageCount: number;
  preview: string | null;
}

export interface SessionMessage {
  id: string;
  seq: number;
  role: MessageRole;
  time: string | null;
  parts: ChroniclerPart[];
}

export type ChroniclerPart =
  | { kind: "text"; text: string }
  | { kind: "tool-call"; tool: string; callID: string; args: string }
  | { kind: "tool-result"; callID: string; output: string; isError: boolean }
  | { kind: "reasoning"; text: string }
  | { kind: "step-start"; meta: string | null }
  | { kind: "step-finish"; meta: string | null }
  | { kind: "status"; type: string; detail: string | null }
  | { kind: "file"; name: string | null; mime: string | null }
  | { kind: "unknown"; type: string; raw: string };

export interface SessionDoc {
  meta: SessionMeta;
  messages: SessionMessage[];
}

export type DocDirection = "head" | "tail";

export interface BoundedDoc {
  meta: SessionMeta;
  messages: SessionMessage[];
  totalMessages: number;
  direction: DocDirection;
  tokenBudget: number;
  truncatedBoundary: boolean;
}

export interface BoundedSessions {
  rows: SessionSummary[];
  totalRows: number;
  tokenBudget: number;
  estimatedTokens: number;
}

export interface RenderOptions {
  includeToolOutput: boolean;
  maxPartChars: number;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = { includeToolOutput: true, maxPartChars: 2000 };
