/*
  Warnings:

  - The `role` column on the `User` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[businessId,email]` on the table `Customer` will be added. If there are existing duplicate values, this will fail.
  - Changed the type of `type` on the `ActivityEvent` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "ActivityEventType" AS ENUM ('CONVERSATION_CREATED', 'MESSAGE_SENT', 'ORDER_PLACED', 'ORDER_UPDATED', 'CUSTOMER_TAGGED', 'LEAD_SCORED');

-- DropIndex
DROP INDEX "Customer_businessId_email_idx";

-- AlterTable
ALTER TABLE "ActivityEvent" DROP COLUMN "type",
ADD COLUMN     "type" "ActivityEventType" NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "role",
ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'OWNER';

-- CreateIndex
CREATE UNIQUE INDEX "Customer_businessId_email_key" ON "Customer"("businessId", "email");

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
