import { DEFAULT_RENDER_OPTIONS } from "../domain/types";
import type { RenderOptions, SessionDoc, SessionMessage } from "../domain/types";
import { renderPart } from "./parts";

function orDash(value: string | null): string {
  return value === null ? "\u2014" : value;
}

function renderMessage(message: SessionMessage, opts: RenderOptions): string {
  const time = message.time ?? "time unknown";
  const heading = `## ${message.role} \u2014 ${time}`;
  const body = message.parts
    .map((part) => renderPart(part, opts))
    .filter((rendered) => rendered.length > 0)
    .join("\n\n");
  return body.length > 0 ? `${heading}\n\n${body}` : heading;
}

export function renderSession(doc: SessionDoc, opts: RenderOptions = DEFAULT_RENDER_OPTIONS): string {
  const o = opts ?? DEFAULT_RENDER_OPTIONS;
  const { meta, messages } = doc;

  const parentLine =
    meta.parentID !== null
      ? `- **Parent**: ${orDash(meta.parentID)} \u2014 subagent session`
      : "- **Parent**: \u2014";

  const header = [
    `# ${meta.title ?? meta.id}`,
    "",
    `- **ID**: \`${meta.id}\``,
    `- **Directory**: ${orDash(meta.directory)}`,
    `- **Created**: ${orDash(meta.createdAt)}`,
    `- **Updated**: ${orDash(meta.updatedAt)}`,
    `- **Project**: ${orDash(meta.projectID)}`,
    parentLine,
    `- **Version**: ${orDash(meta.version)}`,
    `- **Messages**: ${messages.length}`,
    "",
    "---",
  ].join("\n");

  if (messages.length === 0) {
    return `${header}\n\n_No messages recorded._`;
  }

  const body = messages.map((message) => renderMessage(message, o)).join("\n\n");
  return `${header}\n\n${body}`;
}
