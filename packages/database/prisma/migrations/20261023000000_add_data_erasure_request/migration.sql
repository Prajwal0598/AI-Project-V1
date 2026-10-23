-- CreateTable
CREATE TABLE "DataErasureRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "requestReference" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "verificationMethod" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "executedByUserId" TEXT NOT NULL,
    "counts" JSONB,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DataErasureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DataErasureRequest_businessId_customerId_idx" ON "DataErasureRequest"("businessId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "DataErasureRequest_businessId_customerId_requestReference_key" ON "DataErasureRequest"("businessId", "customerId", "requestReference");
