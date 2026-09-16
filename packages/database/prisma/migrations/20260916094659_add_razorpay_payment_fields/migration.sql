/*
  Warnings:

  - A unique constraint covering the columns `[razorpayPaymentLinkId]` on the table `Order` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "razorpayKeyId" TEXT,
ADD COLUMN     "razorpayKeySecretEncrypted" TEXT,
ADD COLUMN     "razorpayWebhookSecretEncrypted" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "razorpayPaymentId" TEXT,
ADD COLUMN     "razorpayPaymentLinkId" TEXT,
ADD COLUMN     "razorpayPaymentLinkUrl" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Order_razorpayPaymentLinkId_key" ON "Order"("razorpayPaymentLinkId");
