-- CreateEnum
CREATE TYPE "FulfillmentStatus" AS ENUM ('NOT_STARTED', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNED');

-- CreateEnum
CREATE TYPE "ConversationOutcome" AS ENUM ('OPEN', 'SALE', 'SUPPORT', 'ESCALATED', 'LOST', 'ABANDONED');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "outcome" "ConversationOutcome" NOT NULL DEFAULT 'OPEN';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "fulfillmentStatus" "FulfillmentStatus" NOT NULL DEFAULT 'NOT_STARTED';
