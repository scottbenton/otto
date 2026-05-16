import { z } from "zod";

export const StateFileSchema = z.object({
  machineId: z.uuid(),
  lastPolled: z.record(z.string(), z.string()).default({}),
  seenCommentIds: z.record(z.string(), z.number().int().array()).default({}),
});

export type StateFile = z.infer<typeof StateFileSchema>;
