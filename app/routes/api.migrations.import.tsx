import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { createMigrationJob } from "../lib/services/migrationJob.service";
import { migrationJobForOwnerReadyWhere } from "../lib/services/storeConnection.service";
import {
  MAX_MIGRATION_PACKAGE_BYTES,
  parseMigrationPackage,
} from "../lib/services/migrationPackage.service";
import { enqueueOrRunInline } from "../lib/queue/enqueueOrRun.server";
import { migrationQueue } from "../lib/queue/queues";
import { startMigration } from "../lib/services/orchestrator.service";

export const loader = async ({ request }: LoaderFunctionArgs) => redirect("/app");

function backWithError(request: Request, message: string) {
  const url = new URL(request.url);
  const params = new URLSearchParams({ packageError: message });
  const host = url.searchParams.get("host");
  if (host) params.set("host", host);
  return redirect(`/app?${params.toString()}`);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const owner = await db.shop.findUniqueOrThrow({ where: { shopDomain: session.shop } });
  const form = await request.formData();
  const connectionId = String(form.get("storeConnectionId") ?? "");
  const upload = form.get("package");
  if (!(upload instanceof File) || upload.size === 0) return backWithError(request, "Choose a Duplify migration package ZIP.");
  if (upload.size > MAX_MIGRATION_PACKAGE_BYTES) return backWithError(request, "The migration package must be 100 MB or smaller.");
  const connection = await db.storeConnection.findFirst({
    where: { id: connectionId, ownerShopId: owner.id, status: "READY" },
    include: { sourceShop: true, destinationShop: true },
  });
  if (!connection) return backWithError(request, "Choose a connected destination store pair.");

  try {
    const parsed = parseMigrationPackage(new Uint8Array(await upload.arrayBuffer()));
    if (parsed.manifest.sourceShop.toLowerCase() !== connection.sourceShop.shopDomain.toLowerCase()) {
      return backWithError(
        request,
        `This package belongs to ${parsed.manifest.sourceShop}. Choose a store pair with that source store.`,
      );
    }
    const job = await createMigrationJob({
      storeConnectionId: connection.id,
      type: "CUSTOM",
      selectedResources: parsed.manifest.selectedResources,
      conflictStrategy: parsed.manifest.conflictStrategy,
    });
    await db.migrationItem.createMany({
      data: parsed.items.map((item) => ({
        migrationJobId: job.id,
        resourceType: item.resourceType,
        stage: item.stage,
        sourceId: item.sourceId,
        status: "PENDING" as const,
        payload: item.payload ?? undefined,
      })),
    });
    await db.migrationJob.update({ where: { id: job.id }, data: { status: "QUEUED" } });
    await enqueueOrRunInline({
      queue: migrationQueue,
      jobName: "import-package",
      data: { migrationJobId: job.id, mode: "start" as const },
      runInline: () => startMigration(job.id),
      label: "migration-package-import",
    });
    return redirect(`/app/migrations/${job.id}/progress`);
  } catch (error) {
    return backWithError(
      request,
      error instanceof Error ? error.message : "Could not import this package.",
    );
  }
};
