-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "StoreConnectionStatus" AS ENUM ('PENDING', 'READY', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MigrationType" AS ENUM ('FULL', 'PRODUCTS', 'COLLECTIONS', 'CUSTOMERS', 'CONTENT', 'THEME', 'CUSTOM');

-- CreateEnum
CREATE TYPE "MigrationJobStatus" AS ENUM ('DRAFT', 'SCANNING', 'SCANNED', 'QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MigrationItemStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'SKIPPED', 'FAILED', 'RETRYING');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('INFO', 'WARN', 'ERROR', 'DEBUG');

-- CreateEnum
CREATE TYPE "ConflictReason" AS ENUM ('DUPLICATE_HANDLE', 'DUPLICATE_SKU', 'DUPLICATE_EMAIL');

-- CreateEnum
CREATE TYPE "ConflictResolution" AS ENUM ('UNRESOLVED', 'OVERWRITE', 'SKIP', 'MERGE', 'CREATE_NEW');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreConnection" (
    "id" TEXT NOT NULL,
    "ownerShopId" TEXT NOT NULL,
    "sourceShopId" TEXT NOT NULL,
    "destinationShopId" TEXT NOT NULL,
    "status" "StoreConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationJob" (
    "id" TEXT NOT NULL,
    "storeConnectionId" TEXT NOT NULL,
    "type" "MigrationType" NOT NULL,
    "status" "MigrationJobStatus" NOT NULL DEFAULT 'DRAFT',
    "selectedResources" JSONB NOT NULL,
    "conflictStrategy" JSONB NOT NULL,
    "scanSummary" JSONB,
    "totalRecords" INTEGER NOT NULL DEFAULT 0,
    "completedRecords" INTEGER NOT NULL DEFAULT 0,
    "failedRecords" INTEGER NOT NULL DEFAULT 0,
    "skippedRecords" INTEGER NOT NULL DEFAULT 0,
    "currentStage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "estimatedCompletionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationItem" (
    "id" TEXT NOT NULL,
    "migrationJobId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "destinationId" TEXT,
    "status" "MigrationItemStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationLog" (
    "id" TEXT NOT NULL,
    "migrationJobId" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MigrationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdMapping" (
    "id" TEXT NOT NULL,
    "storeConnectionId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    "sourceHandle" TEXT,
    "destinationHandle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conflict" (
    "id" TEXT NOT NULL,
    "migrationJobId" TEXT NOT NULL,
    "storeConnectionId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceHandle" TEXT,
    "matchedDestinationId" TEXT,
    "conflictReason" "ConflictReason" NOT NULL,
    "resolution" "ConflictResolution" NOT NULL DEFAULT 'UNRESOLVED',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "defaultConflictStrategy" JSONB,
    "notificationEmail" TEXT,
    "timezone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Shop_isActive_idx" ON "Shop"("isActive");

-- CreateIndex
CREATE INDEX "StoreConnection_ownerShopId_idx" ON "StoreConnection"("ownerShopId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreConnection_sourceShopId_destinationShopId_key" ON "StoreConnection"("sourceShopId", "destinationShopId");

-- CreateIndex
CREATE INDEX "MigrationJob_storeConnectionId_status_idx" ON "MigrationJob"("storeConnectionId", "status");

-- CreateIndex
CREATE INDEX "MigrationJob_createdAt_idx" ON "MigrationJob"("createdAt");

-- CreateIndex
CREATE INDEX "MigrationItem_migrationJobId_status_idx" ON "MigrationItem"("migrationJobId", "status");

-- CreateIndex
CREATE INDEX "MigrationItem_migrationJobId_resourceType_idx" ON "MigrationItem"("migrationJobId", "resourceType");

-- CreateIndex
CREATE INDEX "MigrationItem_migrationJobId_stage_idx" ON "MigrationItem"("migrationJobId", "stage");

-- CreateIndex
CREATE INDEX "MigrationLog_migrationJobId_createdAt_idx" ON "MigrationLog"("migrationJobId", "createdAt");

-- CreateIndex
CREATE INDEX "MigrationLog_migrationJobId_level_idx" ON "MigrationLog"("migrationJobId", "level");

-- CreateIndex
CREATE INDEX "IdMapping_storeConnectionId_resourceType_destinationId_idx" ON "IdMapping"("storeConnectionId", "resourceType", "destinationId");

-- CreateIndex
CREATE UNIQUE INDEX "IdMapping_storeConnectionId_resourceType_sourceId_key" ON "IdMapping"("storeConnectionId", "resourceType", "sourceId");

-- CreateIndex
CREATE INDEX "Conflict_migrationJobId_resolution_idx" ON "Conflict"("migrationJobId", "resolution");

-- CreateIndex
CREATE INDEX "WebhookEvent_shopId_topic_idx" ON "WebhookEvent"("shopId", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "AppSetting_shopId_key" ON "AppSetting"("shopId");

-- AddForeignKey
ALTER TABLE "StoreConnection" ADD CONSTRAINT "StoreConnection_ownerShopId_fkey" FOREIGN KEY ("ownerShopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreConnection" ADD CONSTRAINT "StoreConnection_sourceShopId_fkey" FOREIGN KEY ("sourceShopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreConnection" ADD CONSTRAINT "StoreConnection_destinationShopId_fkey" FOREIGN KEY ("destinationShopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationJob" ADD CONSTRAINT "MigrationJob_storeConnectionId_fkey" FOREIGN KEY ("storeConnectionId") REFERENCES "StoreConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationItem" ADD CONSTRAINT "MigrationItem_migrationJobId_fkey" FOREIGN KEY ("migrationJobId") REFERENCES "MigrationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationLog" ADD CONSTRAINT "MigrationLog_migrationJobId_fkey" FOREIGN KEY ("migrationJobId") REFERENCES "MigrationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdMapping" ADD CONSTRAINT "IdMapping_storeConnectionId_fkey" FOREIGN KEY ("storeConnectionId") REFERENCES "StoreConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conflict" ADD CONSTRAINT "Conflict_migrationJobId_fkey" FOREIGN KEY ("migrationJobId") REFERENCES "MigrationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conflict" ADD CONSTRAINT "Conflict_storeConnectionId_fkey" FOREIGN KEY ("storeConnectionId") REFERENCES "StoreConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppSetting" ADD CONSTRAINT "AppSetting_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

