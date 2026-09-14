-- CreateEnum
CREATE TYPE "PromotionTargetSegment" AS ENUM ('ALL_CUSTOMERS', 'CATEGORY_BUYERS', 'HIGH_VALUE_CUSTOMERS');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OpportunityType" ADD VALUE 'NEW_PRODUCT_MATCH';
ALTER TYPE "OpportunityType" ADD VALUE 'PROMOTION';
ALTER TYPE "OpportunityType" ADD VALUE 'UNANSWERED_CONVERSATION';
ALTER TYPE "OpportunityType" ADD VALUE 'LOW_ENGAGEMENT';
ALTER TYPE "OpportunityType" ADD VALUE 'HIGH_VALUE_CUSTOMER';

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "defaultLowEngagementDays" INTEGER NOT NULL DEFAULT 45,
ADD COLUMN     "highValueLeadScoreThreshold" INTEGER NOT NULL DEFAULT 70;

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "discountDescription" TEXT,
    "targetSegment" "PromotionTargetSegment" NOT NULL,
    "categoryId" TEXT,
    "broadcastedAt" TIMESTAMP(3),
    "broadcastCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Promotion_businessId_createdAt_idx" ON "Promotion"("businessId", "createdAt");

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
