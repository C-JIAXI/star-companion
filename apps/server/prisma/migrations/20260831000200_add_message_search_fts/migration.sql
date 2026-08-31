CREATE VIRTUAL TABLE "MessageSearch" USING fts5(
  "messageId" UNINDEXED,
  "chatId" UNINDEXED,
  "content",
  tokenize = 'trigram'
);

INSERT INTO "MessageSearch" ("messageId", "chatId", "content")
SELECT "id", "chatId", "content" FROM "Message";

CREATE TRIGGER "Message_search_after_insert"
AFTER INSERT ON "Message"
BEGIN
  INSERT INTO "MessageSearch" ("messageId", "chatId", "content") VALUES (new."id", new."chatId", new."content");
END;

CREATE TRIGGER "Message_search_after_update"
AFTER UPDATE OF "content", "chatId" ON "Message"
BEGIN
  DELETE FROM "MessageSearch" WHERE "messageId" = old."id";
  INSERT INTO "MessageSearch" ("messageId", "chatId", "content") VALUES (new."id", new."chatId", new."content");
END;

CREATE TRIGGER "Message_search_after_delete"
AFTER DELETE ON "Message"
BEGIN
  DELETE FROM "MessageSearch" WHERE "messageId" = old."id";
END;
