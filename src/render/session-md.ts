import { DEFAULT_RENDER_OPTIONS } from "../domain/types";
import type { BoundedDoc, RenderOptions, SessionMessage, SessionMeta } from "../domain/types";
import { boundaryPartChars, estimateTokens, HEADER_RESERVE_CHARS } from "../limits";
import { formatNumber } from "./format";
import { renderPart, TRUNCATION_MARKER } from "./parts";

function orDash(value: string | null): string {
  return value === null ? "\u2014" : value;
}

export interface RenderedMessage {
  text: string;
  truncatedParts: number;
}

export function renderMessageDetailed(
  message: SessionMessage,
  opts: RenderOptions,
): RenderedMessage {
  const heading = `## ${message.role} \u2014 ${message.time ?? "time unknown"}`;
  const rendered = message.parts.map((part) => renderPart(part, opts));
  const truncatedParts = rendered.filter((text) => text.includes(TRUNCATION_MARKER)).length;
  const body = rendered.filter((text) => text.length > 0).join("\n\n");
  return { text: body.length > 0 ? `${heading}\n\n${body}` : heading, truncatedParts };
}

export function renderMessage(message: SessionMessage, opts: RenderOptions): string {
  return renderMessageDetailed(message, opts).text;
}

export function renderSessionHeader(
  meta: SessionMeta,
  messagesLine: string,
  tokenLine: string,
  truncatedLine: string,
): string {
  const parentLine =
    meta.parentID !== null
      ? `- **Parent**: ${orDash(meta.parentID)} \u2014 subagent session`
      : "- **Parent**: \u2014";

  return [
    `# ${meta.title ?? meta.id}`,
    "",
    `- **ID**: \`${meta.id}\``,
    `- **Directory**: ${orDash(meta.directory)}`,
    `- **Created**: ${orDash(meta.createdAt)}`,
    `- **Updated**: ${orDash(meta.updatedAt)}`,
    `- **Project**: ${orDash(meta.projectID)}`,
    parentLine,
    `- **Version**: ${orDash(meta.version)}`,
    messagesLine,
    tokenLine,
    truncatedLine,
    "",
    "---",
  ].join("\n");
}

function tokenLine(tokens: number, tokenBudget: number): string {
  return `- **Tokens**: \u2248${formatNumber(tokens)} of ${formatNumber(tokenBudget)} budget`;
}

function truncatedLine(omitted: number, truncatedParts: number): string {
  const reasons: string[] = [];
  if (omitted > 0) reasons.push(`${formatNumber(omitted)} messages omitted`);
  if (truncatedParts > 0) {
    reasons.push(`${formatNumber(truncatedParts)} part${truncatedParts === 1 ? "" : "s"} truncated`);
  }
  return reasons.length > 0
    ? `- **Truncated**: yes \u2014 ${reasons.join(", ")}`
    : "- **Truncated**: no";
}

function omissionNotice(doc: BoundedDoc, shown: number, omitted: number): string {
  const side = doc.direction === "head" ? "later" : "earlier";
  const which = doc.direction === "head" ? "first" : "last";
  return `_\u2026 ${formatNumber(omitted)} ${side} messages omitted \u2014 showing the ${which} ${formatNumber(shown)} of ${formatNumber(doc.totalMessages)}. \u2026_`;
}

function boundaryNotice(tokenBudget: number): string {
  return `_\u2026 one message was truncated to fit the \u2248${formatNumber(tokenBudget)}-token budget. \u2026_`;
}

export function renderBoundedDoc(
  doc: BoundedDoc,
  opts: RenderOptions = DEFAULT_RENDER_OPTIONS,
): string {
  const o = opts ?? DEFAULT_RENDER_OPTIONS;
  const total = doc.totalMessages;
  const shown = doc.messages.length;
  const omitted = Math.max(0, total - shown);

  const messagesLine =
    omitted > 0
      ? `- **Messages**: ${formatNumber(total)} (showing ${doc.direction === "head" ? "first" : "last"} ${formatNumber(shown)})`
      : `- **Messages**: ${formatNumber(total)}`;

  if (total === 0) {
    const tokens = estimateTokens(HEADER_RESERVE_CHARS);
    const header = renderSessionHeader(
      doc.meta,
      messagesLine,
      tokenLine(tokens, doc.tokenBudget),
      truncatedLine(0, 0),
    );
    return `${header}\n\n_No messages recorded._`;
  }

  const boundary =
    doc.truncatedBoundary && shown > 0
      ? doc.direction === "head"
        ? doc.messages[shown - 1]!
        : doc.messages[0]!
      : null;
  const boundaryOpts: RenderOptions =
    boundary === null
      ? o
      : {
          ...o,
          maxPartChars: boundaryPartChars(doc.tokenBudget, boundary.parts.length, o.maxPartChars),
        };

  const notices: string[] = [];
  if (omitted > 0) notices.push(omissionNotice(doc, shown, omitted));
  if (doc.truncatedBoundary) notices.push(boundaryNotice(doc.tokenBudget));

  let truncatedParts = 0;
  const body = doc.messages
    .map((message) => {
      const rendered = renderMessageDetailed(message, message === boundary ? boundaryOpts : o);
      truncatedParts += rendered.truncatedParts;
      return rendered.text;
    })
    .join("\n\n");

  const noticeBlock = notices.join("\n\n");
  const tokens = estimateTokens(HEADER_RESERVE_CHARS + noticeBlock.length + body.length);
  const header = renderSessionHeader(
    doc.meta,
    messagesLine,
    tokenLine(tokens, doc.tokenBudget),
    truncatedLine(omitted, truncatedParts),
  );

  return [header, noticeBlock, body].filter((section) => section.length > 0).join("\n\n");
}
