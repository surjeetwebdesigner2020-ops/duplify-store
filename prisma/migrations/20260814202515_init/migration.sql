-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StoreConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerShopId" TEXT NOT NULL,
    "sourceShopId" TEXT NOT NULL,
    "destinationShopId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoreConnection_ownerShopId_fkey" FOREIGN KEY ("ownerShopId") REFERENCES "Shop" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StoreConnection_sourceShopId_fkey" FOREIGN KEY ("sourceShopId") REFERENCES "Shop" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StoreConnection_destinationShopId_fkey" FOREIGN KEY ("destinationShopId") REFERENCES "Shop" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MigrationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeConnectionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "selectedResources" JSONB NOT NULL,
    "conflictStrategy" JSONB NOT NULL,
    "scanSummary" JSONB,
    "totalRecords" INTEGER NOT NULL DEFAULT 0,
    "completedRecords" INTEGER NOT NULL DEFAULT 0,
    "failedRecords" INTEGER NOT NULL DEFAULT 0,
    "skippedRecords" INTEGER NOT NULL DEFAULT 0,
    "currentStage" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "estimatedCompletionAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MigrationJob_storeConnectionId_fkey" FOREIGN KEY ("storeConnectionId") REFERENCES "StoreConnection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MigrationItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "migrationJobId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "destinationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "payload" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MigrationItem_migrationJobId_fkey" FOREIGN KEY ("migrationJobId") REFERENCES "MigrationJob" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MigrationLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "migrationJobId" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MigrationLog_migrationJobId_fkey" FOREIGN KEY ("migrationJobId") REFERENCES "MigrationJob" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IdMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeConnectionId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    "sourceHandle" TEXT,
    "destinationHandle" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IdMapping_storeConnectionId_fkey" FOREIGN KEY ("storeConnectionId") REFERENCES "StoreConnection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Conflict" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "migrationJobId" TEXT NOT NULL,
    "storeConnectionId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceHandle" TEXT,
    "matchedDestinationId" TEXT,
    "conflictReason" TEXT NOT NULL,
    "resolution" TEXT NOT NULL DEFAULT 'UNRESOLVED',
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Conflict_migrationJobId_fkey" FOREIGN KEY ("migrationJobId") REFERENCES "MigrationJob" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Conflict_storeConnectionId_fkey" FOREIGN KEY ("storeConnectionId") REFERENCES "StoreConnection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "defaultConflictStrategy" JSONB,
    "notificationEmail" TEXT,
    "timezone" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AppSetting_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

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

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");
