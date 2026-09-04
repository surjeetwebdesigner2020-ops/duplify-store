import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { migrationJobForOwnerWhere } from "../lib/services/storeConnection.service";
import { getMigrationJob } from "../lib/services/migrationJob.service";
import { prepareMigrationPackage } from "../lib/services/migrationPackage.service";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({ where: { shopDomain: session.shop } });
  const ownedJob = await db.migrationJob.findFirst({ where: migrationJobForOwnerWhere(params.id!, shop.id), select: { id: true } });
  if (!ownedJob) return new Response("Not found", { status: 404 });
  const job = await getMigrationJob(ownedJob.id);
  if (!job) return new Response("Not found", { status: 404 });
  const packageBytes = await prepareMigrationPackage(job);
  return new Response(new Blob([new Uint8Array(packageBytes)], { type: "application/zip" }), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="duplify-${job.id}-migration.zip"`,
      "Cache-Control": "no-store",
    },
  });
};
