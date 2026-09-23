-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "assistedBuyingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "assistedBuyingMaxRecommendations" INTEGER NOT NULL DEFAULT 5;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "assistedBuyingContext" JSONB;
