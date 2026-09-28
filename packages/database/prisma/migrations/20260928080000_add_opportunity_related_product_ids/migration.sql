-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN     "relatedProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
