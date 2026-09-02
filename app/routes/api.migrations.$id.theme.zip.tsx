import type { LoaderFunctionArgs } from "react-router";
import { zipSync, strToU8 } from "fflate";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { migrationJobForOwnerWhere } from "../lib/services/storeConnection.service";

type ThemeFile = { filename: string; bodyType: "TEXT" | "BASE64" | "URL"; value: string };

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({ where: { shopDomain: session.shop } });
  const job = await db.migrationJob.findFirst({
    where: migrationJobForOwnerWhere(params.id!, shop.id),
  });
  if (!job) return new Response("Not found", { status: 404 });

  const item = await db.migrationItem.findFirst({
    where: { migrationJobId: job.id, resourceType: "theme" },
  });
  if (!item) return new Response("Theme files are not available for this migration", { status: 404 });

  const payload = item.payload as unknown as { themeName?: string; files?: ThemeFile[] };
  const files: Record<string, Uint8Array> = {};
  for (const file of payload.files ?? []) {
    if (!file.filename || typeof file.value !== "string") continue;
    if (file.bodyType === "BASE64") files[file.filename] = decodeBase64(file.value);
    else if (file.bodyType === "URL") files[file.filename] = new Uint8Array(await (await fetch(file.value)).arrayBuffer());
    else files[file.filename] = strToU8(file.value);
  }

  const archive = zipSync(files, { level: 6 });
  return new Response(archive, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${(payload.themeName ?? "theme-copy").replace(/[^a-z0-9._-]+/gi, "-")}.zip"`,
      "Cache-Control": "no-store",
    },
  });
};