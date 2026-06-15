-- Add activeKey to enforce single-active-conversation-per-lead at DB level.
-- NULL when conversation is CLOSED / ESCALATED / NO_RESPONSE; equals leadId otherwise.
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "activeKey" TEXT;

-- Backfill: set activeKey = leadId for currently active conversations
-- (terminal states stay NULL so new conversations can be opened)
UPDATE "Conversation"
SET "activeKey" = "leadId"
WHERE "state" NOT IN ('CLOSED', 'ESCALATED', 'NO_RESPONSE')
  AND "activeKey" IS NULL;

-- If multiple active conversations exist for the same lead (legacy race condition),
-- keep only the most recent one as active; null out the rest.
WITH ranked AS (
  SELECT "id",
         ROW_NUMBER() OVER (PARTITION BY "leadId" ORDER BY "createdAt" DESC) AS rn
  FROM "Conversation"
  WHERE "activeKey" IS NOT NULL
)
UPDATE "Conversation"
SET "activeKey" = NULL
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_activeKey_key" ON "Conversation"("activeKey");
