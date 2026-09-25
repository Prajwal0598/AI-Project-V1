-- CreateEnum
CREATE TYPE "WhatsAppConnectionStatus" AS ENUM ('DISCONNECTED', 'ONBOARDING', 'AUTHORIZED', 'CONFIGURING', 'WEBHOOK_CONNECTED', 'CONNECTED', 'RETRY_REQUIRED', 'SETUP_REQUIRED');

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "metaBusinessId" TEXT,
ADD COLUMN     "whatsappBusinessAccountId" TEXT,
ADD COLUMN     "whatsappDisplayPhoneNumber" TEXT,
ADD COLUMN     "whatsappConnectionStatus" "WhatsAppConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
ADD COLUMN     "whatsappConnectedAt" TIMESTAMP(3),
ADD COLUMN     "whatsappLastValidatedAt" TIMESTAMP(3),
ADD COLUMN     "whatsappLastErrorCode" TEXT,
ADD COLUMN     "whatsappLastErrorMessage" TEXT;
