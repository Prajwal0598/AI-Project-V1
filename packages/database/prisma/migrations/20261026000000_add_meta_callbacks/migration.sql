-- AlterEnum
ALTER TYPE "WhatsAppConnectionStatus" ADD VALUE 'DEAUTHORIZED';

-- CreateTable
CREATE TABLE "MetaUserLink" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "metaUserId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaUserLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaCallbackRequest" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "confirmationCode" TEXT,
    "metaUserId" TEXT,
    "status" TEXT NOT NULL,
    "matchedBusinessIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connectionsRevoked" INTEGER NOT NULL DEFAULT 0,
    "signedRequestIssuedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolutionReference" TEXT,
    "verificationMethod" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MetaCallbackRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaCallbackEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "actorUserId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaCallbackEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetaUserLink_metaUserId_idx" ON "MetaUserLink"("metaUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaUserLink_businessId_metaUserId_key" ON "MetaUserLink"("businessId", "metaUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaCallbackRequest_dedupeKey_key" ON "MetaCallbackRequest"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "MetaCallbackRequest_confirmationCode_key" ON "MetaCallbackRequest"("confirmationCode");

-- CreateIndex
CREATE INDEX "MetaCallbackRequest_kind_status_idx" ON "MetaCallbackRequest"("kind", "status");

-- CreateIndex
CREATE INDEX "MetaCallbackRequest_metaUserId_idx" ON "MetaCallbackRequest"("metaUserId");

-- CreateIndex
CREATE INDEX "MetaCallbackEvent_requestId_createdAt_idx" ON "MetaCallbackEvent"("requestId", "createdAt");

-- AddForeignKey
ALTER TABLE "MetaUserLink" ADD CONSTRAINT "MetaUserLink_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaCallbackEvent" ADD CONSTRAINT "MetaCallbackEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MetaCallbackRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
