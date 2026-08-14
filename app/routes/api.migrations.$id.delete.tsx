import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { migrationJobForOwnerWhere } from "../lib/services/storeConnection.service";

const ACTIVE_STATUSES = new Set(["SCANNING", "QUEUED", "RUNNING"]);

export const loader = async (_args: LoaderFunctionArgs) => {
  return redirect("/app/migrations");
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });
  const form = await request.formData();
  const returnTo = String(form.get("returnTo") || "/app/migrations");

  const job = await db.migrationJob.findFirst({
    where: migrationJobForOwnerWhere(params.id!, shop.id),
  });
  if (!job) {
    return redirect("/app/migrations");
  }

  if (ACTIVE_STATUSES.has(job.status)) {
    return redirect(returnTo.startsWith("/app") ? returnTo : "/app/migrations");
  }

  const storeConnectionId = job.storeConnectionId;

  await db.$transaction(async (tx) => {
    await tx.conflict.deleteMany({ where: { migrationJobId: job.id } });
    await tx.migrationLog.deleteMany({ where: { migrationJobId: job.id } });
    await tx.migrationItem.deleteMany({ where: { migrationJobId: job.id } });
    await tx.migrationJob.delete({ where: { id: job.id } });

    // When history for this store pair is gone, also clear ID mappings so
    // "History" and "ID mappings" stay in sync for a clean re-run.
    const remainingJobs = await tx.migrationJob.count({
      where: { storeConnectionId },
    });
    if (remainingJobs === 0) {
      await tx.idMapping.deleteMany({ where: { storeConnectionId } });
      await tx.conflict.deleteMany({ where: { storeConnectionId } });
    }
  });

  return redirect(returnTo.startsWith("/app") ? returnTo : "/app/migrations");
};
