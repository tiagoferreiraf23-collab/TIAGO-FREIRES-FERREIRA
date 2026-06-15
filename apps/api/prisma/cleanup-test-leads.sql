-- Remove all leads created via the test chat panel and their conversations/messages
DELETE FROM "Message" WHERE "conversationId" IN (
  SELECT "id" FROM "Conversation" WHERE "leadId" IN (
    SELECT "id" FROM "Lead" WHERE "source" = 'test_panel'
  )
);
DELETE FROM "Conversation" WHERE "leadId" IN (
  SELECT "id" FROM "Lead" WHERE "source" = 'test_panel'
);
DELETE FROM "Lead" WHERE "source" = 'test_panel';
