import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { runScan } from "../lib/services/scan.service";
import { migrationJobForOwnerReadyWhere } from "../lib/services/storeConnection.service";
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
  });
  if (!job) {
    return redirect("/app/migrations");
  }

  // Allow re-kick from SCANNING so merchants can recover stuck scans when
  // the queue had no worker connected.
  if (!["DRAFT", "SCANNED", "FAILED", "SCANNING"].includes(job.status)) {
    return redirect(`/app/migrations/${job.id}/scan`);
  }

  await db.migrationJob.update({
    where: { id: job.id },
    data: { status: "SCANNING", currentStage: null },
  });

  const { scanQueue } = await import("../lib/queue/queues");
  await enqueueOrRunInline({
    queue: scanQueue,
    jobName: "scan",
    data: { migrationJobId: job.id },
    runInline: () => runScan(job.id),
    label: "scan",
  });

  return redirect(`/app/migrations/${job.id}/scan`);
};
