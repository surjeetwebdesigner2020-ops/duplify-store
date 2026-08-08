import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { migrationJobForOwnerWhere } from "../lib/services/storeConnection.service";

// Lightweight JSON polling endpoint mirroring the fields shown on the
// Migration Progress page — useful for polling without a full page/loader
// revalidation (e.g. a future embedded status widget).
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({ where: { shopDomain: session.shop } });

  const job = await db.migrationJob.findFirst({
    where: migrationJobForOwnerWhere(params.id!, shop.id),
  });
  if (!job) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  return Response.json({
    id: job.id,
    status: job.status,
    currentStage: job.currentStage,
    totalRecords: job.totalRecords,
    completedRecords: job.completedRecords,
    failedRecords: job.failedRecords,
    skippedRecords: job.skippedRecords,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  });
};
