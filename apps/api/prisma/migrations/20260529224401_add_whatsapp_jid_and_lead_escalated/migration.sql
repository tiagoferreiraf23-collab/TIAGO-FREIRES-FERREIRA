-- Add whatsappJid to Lead (privacy-preserving @lid identifier used by Baileys/Evolution)
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "whatsappJid" TEXT;

-- Add unique index on whatsappJid (nullable, so NULLs are not considered duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS "Lead_whatsappJid_key" ON "Lead"("whatsappJid");

-- Add ESCALATED value to LeadStatus enum (used when lead is handed off to human consultant)
ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'ESCALATED';
