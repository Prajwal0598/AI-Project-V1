-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN     "relatedPromotionId" TEXT;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_relatedPromotionId_fkey" FOREIGN KEY ("relatedPromotionId") REFERENCES "Promotion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
