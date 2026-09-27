-- CreateEnum
CREATE TYPE "RazorpayConnectionStatus" AS ENUM ('DISCONNECTED', 'CONNECTED', 'RETRY_REQUIRED');

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "razorpayAccountId" TEXT,
ADD COLUMN     "razorpayAccessTokenEncrypted" TEXT,
ADD COLUMN     "razorpayRefreshTokenEncrypted" TEXT,
ADD COLUMN     "razorpayPublicToken" TEXT,
ADD COLUMN     "razorpayTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "razorpayConnectionStatus" "RazorpayConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
ADD COLUMN     "razorpayConnectedAt" TIMESTAMP(3),
ADD COLUMN     "razorpayLastErrorMessage" TEXT;
