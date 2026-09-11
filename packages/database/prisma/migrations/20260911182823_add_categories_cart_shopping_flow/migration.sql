/*
  Adds Category, Cart, CartItem, and WhatsApp shopping-flow state on Conversation. Existing Product.category
  free-text values are backfilled into real Category rows (one per distinct name per business) before the
  old string column is dropped.
*/
-- CreateEnum
CREATE TYPE "CartStatus" AS ENUM ('ACTIVE', 'CHECKED_OUT', 'ABANDONED');

-- CreateEnum
CREATE TYPE "ShoppingState" AS ENUM ('IDLE', 'MAIN_MENU', 'BROWSING_CATEGORIES', 'BROWSING_PRODUCTS', 'VIEWING_PRODUCT', 'AWAITING_QUANTITY', 'CART_REVIEW', 'COLLECTING_ADDRESS', 'COLLECTING_PAYMENT', 'ORDER_CONFIRMATION');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "activeCategoryId" TEXT,
ADD COLUMN     "activeProductId" TEXT,
ADD COLUMN     "pendingVariantId" TEXT,
ADD COLUMN     "shoppingState" "ShoppingState" NOT NULL DEFAULT 'IDLE';

-- AlterTable (categoryId added now; old "category" string column is dropped further below, after backfill)
ALTER TABLE "Product" ADD COLUMN     "categoryId" TEXT;

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cart" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "CartStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CartItem" (
    "id" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CartItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Category_businessId_active_sortOrder_idx" ON "Category"("businessId", "active", "sortOrder");

-- CreateIndex
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Cart_conversationId_key" ON "Cart"("conversationId");

-- CreateIndex
CREATE INDEX "Cart_businessId_status_idx" ON "Cart"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CartItem_cartId_variantId_key" ON "CartItem"("cartId", "variantId");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DataBackfill: one Category row per distinct non-empty Product.category string, per business
INSERT INTO "Category" ("id", "businessId", "name", "sortOrder", "active", "createdAt", "updatedAt")
SELECT 'cat_' || substr(md5(random()::text || clock_timestamp()::text || "businessId" || "category"), 1, 22),
       "businessId", "category", 0, true, now(), now()
FROM (SELECT DISTINCT "businessId", "category" FROM "Product" WHERE "category" IS NOT NULL AND btrim("category") <> '') AS distinct_categories;

-- DataBackfill: point each Product at its matching new Category row
UPDATE "Product" p
SET "categoryId" = c."id"
FROM "Category" c
WHERE c."businessId" = p."businessId" AND c."name" = p."category";

-- Now safe to drop the old free-text column
ALTER TABLE "Product" DROP COLUMN "category";

