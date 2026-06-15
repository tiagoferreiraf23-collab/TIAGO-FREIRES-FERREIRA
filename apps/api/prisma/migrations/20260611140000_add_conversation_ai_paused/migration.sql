-- Pause flag for manual takeover. Ana stops auto-responding while true.
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "aiPaused" BOOLEAN NOT NULL DEFAULT false;
