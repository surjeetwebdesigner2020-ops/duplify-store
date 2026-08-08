import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { startMigration } from "../lib/services/orchestrator.service";
import { logEvent } from "../lib/services/migrationJob.service";
import type { ScanSummary } from "../lib/services/scan.service";
import {
  liveMissingPermissions,
  needsPermissionRescan,
  storeScopesFromConnection,
} from "../lib/services/permissionStatus.server";
import {
  migrationJobForOwnerReadyWhere,
  refreshShopScopesIfStale,
} from "../lib/services/storeConnection.service";
import { verifyMigrationStoreAccess } from "../lib/services/shopAccess.server";
import { enqueueOrRunInline } from "../lib/queue/enqueueOrRun.server";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  return redirect(`/app/migrations/${params.id}/scan`);
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });

  const job = await db.migrationJob.findFirst({
    where: migrationJobForOwnerReadyWhere(params.id!, shop.id),
    include: {
      storeConnection: { include: { sourceShop: true, destinationShop: true } },
    },
  });
  if (!job) {
    return redirect("/app/migrations");
  }

  if (job.status !== "SCANNED") {
    return redirect(`/app/migrations/${job.id}/scan`);
  }

  const scanSummary = job.scanSummary as ScanSummary | null;
  const selectedResources = job.selectedResources as string[];

  // Refresh live scopes before gating Start — avoids stale "Ready" / false blocks.
  await refreshShopScopesIfStale(job.storeConnection.sourceShop);
  await refreshShopScopesIfStale(job.storeConnection.destinationShop);
  const freshJob = await db.migrationJob.findFirst({
    where: { id: job.id },
    include: {
      storeConnection: { include: { sourceShop: true, destinationShop: true } },
    },
  });
  const connection = freshJob?.storeConnection ?? job.storeConnection;
  const storeScopes = storeScopesFromConnection(connection);
  const missingPermissions = liveMissingPermissions(
    selectedResources,
    storeScopes,
  );
  if (missingPermissions.length > 0) {
    await logEvent(
      job.id,
      "WARN",
      "Migration start blocked because selected resources are missing access",
      {
        missingPermissions,
      },
    );
    return redirect(`/app/migrations/${job.id}/scan`);
  }

  // Live API ping — do not start if Shopify still rejects a store token.
  const badShop = await verifyMigrationStoreAccess(connection);
  if (badShop) {
    await logEvent(
      job.id,
      "WARN",
      `Migration start blocked: reconnect ${badShop} (invalid access token)`,
    );
    return redirect(
      `/app/migrations/${job.id}/scan?startError=${encodeURIComponent(`reconnect:${badShop}`)}`,
    );
  }

  if (needsPermissionRescan(scanSummary, selectedResources, storeScopes)) {
    await logEvent(
      job.id,
      "WARN",
      "Migration start blocked until a fresh scan completes",
    );
    return redirect(`/app/migrations/${job.id}/scan?startError=fresh-scan`);
  }

  await db.migrationJob.update({
    where: { id: job.id },
    data: { status: "QUEUED" },
  });
  const { migrationQueue } = await import("../lib/queue/queues");
  await enqueueOrRunInline({
    queue: migrationQueue,
    jobName: "run",
    data: { migrationJobId: job.id, mode: "start" as const },
    runInline: () => startMigration(job.id),
    label: "migration-start",
  });

  return redirect(`/app/migrations/${job.id}/progress`);
};
