-- CreateEnum
CREATE TYPE "CustomerSignalType" AS ENUM ('PRODUCT_VIEWED', 'PRODUCT_ENQUIRY', 'BACK_IN_STOCK_WANTED');

-- CreateEnum
CREATE TYPE "OpportunityType" AS ENUM ('ABANDONED_CART', 'PRODUCT_ENQUIRY', 'BACK_IN_STOCK');

-- CreateEnum
CREATE TYPE "OpportunityPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('NEW', 'SENT', 'DISMISSED', 'SNOOZED', 'CONVERTED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "proactiveSuggestionsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CustomerSignal" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "CustomerSignalType" NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "OpportunityType" NOT NULL,
    "priority" "OpportunityPriority" NOT NULL DEFAULT 'MEDIUM',
    "score" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "reason" TEXT NOT NULL,
    "estimatedValue" DECIMAL(12,2),
    "status" "OpportunityStatus" NOT NULL DEFAULT 'NEW',
    "relatedProductId" TEXT,
    "relatedCartId" TEXT,
    "snoozedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suggestion" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "editedMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityOutcome" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "orderId" TEXT,
    "attributedRevenue" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpportunityOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerSignal_businessId_customerId_type_idx" ON "CustomerSignal"("businessId", "customerId", "type");

-- CreateIndex
CREATE INDEX "CustomerSignal_businessId_productId_type_idx" ON "CustomerSignal"("businessId", "productId", "type");

-- CreateIndex
CREATE INDEX "Opportunity_businessId_status_priority_idx" ON "Opportunity"("businessId", "status", "priority");

-- CreateIndex
CREATE INDEX "Opportunity_businessId_customerId_type_idx" ON "Opportunity"("businessId", "customerId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Suggestion_opportunityId_key" ON "Suggestion"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityOutcome_opportunityId_key" ON "OpportunityOutcome"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityOutcome_orderId_key" ON "OpportunityOutcome"("orderId");

-- AddForeignKey
ALTER TABLE "CustomerSignal" ADD CONSTRAINT "CustomerSignal_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerSignal" ADD CONSTRAINT "CustomerSignal_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerSignal" ADD CONSTRAINT "CustomerSignal_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerSignal" ADD CONSTRAINT "CustomerSignal_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_relatedProductId_fkey" FOREIGN KEY ("relatedProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_relatedCartId_fkey" FOREIGN KEY ("relatedCartId") REFERENCES "Cart"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Suggestion" ADD CONSTRAINT "Suggestion_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityOutcome" ADD CONSTRAINT "OpportunityOutcome_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityOutcome" ADD CONSTRAINT "OpportunityOutcome_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
