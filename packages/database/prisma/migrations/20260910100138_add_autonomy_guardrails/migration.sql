-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'AWAITING_APPROVAL';

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "autonomyMaxOrderValue" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "escalated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "escalationReason" TEXT;

-- CreateTable
CREATE TABLE "AiActionLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "conversationId" TEXT,
    "orderId" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "result" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiActionLog_businessId_createdAt_idx" ON "AiActionLog"("businessId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiActionLog" ADD CONSTRAINT "AiActionLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
