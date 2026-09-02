-- AlterTable
ALTER TABLE "Business" ADD COLUMN "instagramPageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Business_instagramPageId_key" ON "Business"("instagramPageId");
