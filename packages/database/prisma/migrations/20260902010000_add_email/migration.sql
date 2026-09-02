-- AlterTable
ALTER TABLE "Business" ADD COLUMN "supportEmail" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Business_supportEmail_key" ON "Business"("supportEmail");
