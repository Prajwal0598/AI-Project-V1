-- DropIndex
DROP INDEX "Cart_conversationId_key";

-- CreateIndex
CREATE INDEX "Cart_conversationId_status_idx" ON "Cart"("conversationId", "status");
