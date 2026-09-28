-- CreateTable
CREATE TABLE "AiModelInvocation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "conversationId" TEXT,
    "experimentId" TEXT,
    "variant" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "success" BOOLEAN NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estimatedCost" DECIMAL(10,6),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiModelInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiModelInvocation_businessId_createdAt_idx" ON "AiModelInvocation"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "AiModelInvocation_experimentId_variant_idx" ON "AiModelInvocation"("experimentId", "variant");

-- AddForeignKey
ALTER TABLE "AiModelInvocation" ADD CONSTRAINT "AiModelInvocation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
