import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { cancelMigration } from "../lib/services/orchestrator.service";
import { migrationJobForOwnerWhere } from "../lib/services/storeConnection.service";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  return redirect(`/app/migrations/${params.id}/progress`);
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({ where: { shopDomain: session.shop } });

  const job = await db.migrationJob.findFirst({
    where: migrationJobForOwnerWhere(params.id!, shop.id),
  });
  if (!job) {
    return redirect("/app/migrations");
  }

  await cancelMigration(job.id);

  return redirect(`/app/migrations/${job.id}/progress`);
};
