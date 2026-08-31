CREATE INDEX "Chat_deletedAt_isArchived_isCheckpoint_isPinned_updatedAt_id_idx"
ON "Chat"("deletedAt", "isArchived", "isCheckpoint", "isPinned", "updatedAt", "id");

CREATE INDEX "Message_chatId_createdAt_id_idx"
ON "Message"("chatId", "createdAt", "id");

CREATE INDEX "Message_createdAt_id_idx"
ON "Message"("createdAt", "id");

CREATE INDEX "Character_isFavorite_updatedAt_id_idx"
ON "Character"("isFavorite", "updatedAt", "id");

CREATE INDEX "Chat_deletedAt_isArchived_isCheckpoint_folder_isPinned_updatedAt_id_idx"
ON "Chat"("deletedAt", "isArchived", "isCheckpoint", "folder", "isPinned", "updatedAt", "id");

CREATE INDEX "ChatMemory_chatId_updatedAt_id_idx"
ON "ChatMemory"("chatId", "updatedAt", "id");

CREATE INDEX "Message_chatId_contextIncluded_createdAt_id_idx"
ON "Message"("chatId", "contextIncluded", "createdAt", "id");

CREATE INDEX "Message_chatId_isBookmarked_createdAt_id_idx"
ON "Message"("chatId", "isBookmarked", "createdAt", "id");

CREATE INDEX "ModelUsageAttempt_startedAt_id_idx"
ON "ModelUsageAttempt"("startedAt", "id");

CREATE INDEX "RecoveryPoint_createdAt_id_idx"
ON "RecoveryPoint"("createdAt", "id");
