/*
  Warnings:

  - You are about to drop the column `active` on the `Product` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'HIDDEN');

-- DropIndex
DROP INDEX "Product_businessId_active_idx";

-- AlterTable (status added with a temporary default; backfilled from "active" below before dropping it)
ALTER TABLE "Product" ADD COLUMN     "status" "ProductStatus" NOT NULL DEFAULT 'PUBLISHED';

-- DataBackfill: preserve existing visibility (active=true -> PUBLISHED, active=false -> HIDDEN)
UPDATE "Product" SET "status" = CASE WHEN "active" THEN 'PUBLISHED' ELSE 'HIDDEN' END::"ProductStatus";

ALTER TABLE "Product" DROP COLUMN "active";

-- CreateIndex
CREATE INDEX "Product_businessId_status_idx" ON "Product"("businessId", "status");
