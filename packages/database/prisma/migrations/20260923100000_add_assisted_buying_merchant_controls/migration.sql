-- CreateEnum
CREATE TYPE "AssistedBuyingRanking" AS ENUM ('BEST_MATCH', 'VALUE', 'PREMIUM', 'NEWEST');

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "assistedBuyingExcludedCategoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "assistedBuyingRankingPreference" "AssistedBuyingRanking" NOT NULL DEFAULT 'BEST_MATCH';
