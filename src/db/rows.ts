import { z } from "zod";

export const SessionV2RowSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  directory: z.string().nullable(),
  project_id: z.string().nullable(),
  parent_id: z.string().nullable(),
  version: z.string().nullable(),
  time_created: z.number().nullable(),
  time_updated: z.number().nullable(),
});
export type SessionV2Row = z.infer<typeof SessionV2RowSchema>;

export const SessionMessageRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  type: z.string().nullable(),
  seq: z.number(),
  time_created: z.number().nullable(),
  time_updated: z.number().nullable(),
  data: z.unknown(),
});
export type SessionMessageRow = z.infer<typeof SessionMessageRowSchema>;
