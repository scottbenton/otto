import { z } from "zod";

export const StateFileSchema = z.object({
  machineId: z.uuid(),
  lastPolled: z.record(z.string(), z.string()).default({}),
  seenCommentIds: z.record(z.string(), z.number().int().array()).default({}),
  repoDefaultBranches: z.record(z.string(), z.string()).default({}),
  worktrees: z.record(z.string(), z.object({
    repo: z.string(),
    path: z.string(),
    branch: z.string()
  })).default({})
});

export type StateFile = z.infer<typeof StateFileSchema>;
