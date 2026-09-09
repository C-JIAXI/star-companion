// This module is also loaded by the mobile backend; keep it free of Prisma.
export class DraftOwnershipError extends Error {
  readonly status = 409;
  readonly details = { code: "draft_managed" };
  constructor() { super("Save these images with the chat draft."); }
}

/** Legacy media endpoints must not mutate version-controlled composer references. */
export const assertUnmanagedDraftId = (draftId: string) => {
  if (draftId.startsWith("draft_composer_") || draftId.startsWith("draft_handoff_")) throw new DraftOwnershipError();
};
