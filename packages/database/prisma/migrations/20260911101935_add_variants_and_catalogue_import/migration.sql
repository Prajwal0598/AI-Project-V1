/*
  Restructures Product into Product + Variant (sku/price/currency/inventory/dimensions move to Variant)
  and adds ImportJob/ImportRow for catalogue import. Existing Product rows are backfilled into a single
  default Variant each before the old columns are dropped, and OrderItem is repointed at that variant.
*/
-- CreateEnum
CREATE TYPE "ProductSource" AS ENUM ('MANUAL', 'IMPORT');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('PENDING', 'READY_FOR_REVIEW', 'COMMITTING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('READY', 'WARNING', 'ERROR');

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "variantId" TEXT;

-- AlterTable (new columns only — old price/currency/inventory columns are dropped further below, after backfill)
ALTER TABLE "Product" ADD COLUMN     "brand" TEXT,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "source" "ProductSource" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "Variant" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "attributes" JSONB,
    "price" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "compareAtPrice" DECIMAL(12,2),
    "costPrice" DECIMAL(12,2),
    "inventory" INTEGER,
    "weight" DECIMAL(10,3),
    "length" DECIMAL(10,2),
    "width" DECIMAL(10,2),
    "height" DECIMAL(10,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'PENDING',
    "rowsDetected" INTEGER NOT NULL DEFAULT 0,
    "rowsReady" INTEGER NOT NULL DEFAULT 0,
    "rowsWarning" INTEGER NOT NULL DEFAULT 0,
    "rowsError" INTEGER NOT NULL DEFAULT 0,
    "columnMapping" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" TEXT NOT NULL,
    "importJobId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "rawData" JSONB NOT NULL,
    "normalizedData" JSONB,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'READY',
    "validationErrors" JSONB,
    "matchedProductId" TEXT,
    "action" TEXT,
    "committedProductId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Variant_businessId_active_idx" ON "Variant"("businessId", "active");

-- CreateIndex
CREATE INDEX "Variant_productId_idx" ON "Variant"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_businessId_sku_key" ON "Variant"("businessId", "sku");

-- CreateIndex
CREATE INDEX "ImportJob_businessId_createdAt_idx" ON "ImportJob"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "ImportRow_importJobId_status_idx" ON "ImportRow"("importJobId", "status");

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "ImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DataBackfill: create one default Variant per existing Product, carrying over price/currency/inventory
INSERT INTO "Variant" ("id", "businessId", "productId", "sku", "price", "currency", "inventory", "active", "createdAt", "updatedAt")
SELECT 'var_' || substr(md5(random()::text || clock_timestamp()::text || "id"), 1, 22),
       "businessId", "id", NULL, "price", "currency", "inventory", "active", "createdAt", "updatedAt"
FROM "Product";

-- DataBackfill: repoint existing OrderItem rows at the new default variant of their product
UPDATE "OrderItem" oi
SET "variantId" = v."id"
FROM "Variant" v
WHERE v."productId" = oi."productId" AND oi."productId" IS NOT NULL;

-- Now safe to drop the old flat pricing/stock columns from Product
ALTER TABLE "Product" DROP COLUMN "currency",
DROP COLUMN "inventory",
DROP COLUMN "price";

