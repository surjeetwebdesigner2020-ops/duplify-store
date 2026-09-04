import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import db from "../../db.server";
import type { MigrationJobWithConnection } from "./orchestrator.service";
import { ensureBlogItems } from "./processors/blogs.processor";
import { ensureCollectionItems } from "./processors/collections.processor";
import { ensureCustomerItems } from "./processors/customers.processor";
import { ensureDiscountItems } from "./processors/discounts.processor";
import { ensureFileItems } from "./processors/files.processor";
import { ensureImageItems } from "./processors/images.processor";
import { ensureInventoryItems } from "./processors/inventory.processor";
import { ensureMenuItems } from "./processors/menus.processor";
import { ensureMetafieldDefinitionItems } from "./processors/metafieldDefinitions.processor";
import { ensureMetaobjectDefinitionItems, ensureMetaobjectEntryItems } from "./processors/metaobjects.processor";
import { ensureOrderItems } from "./processors/orders.processor";
import { ensurePageItems } from "./processors/pages.processor";
import { ensureProductItems } from "./processors/products.processor";
import { ensureThemeItems } from "./processors/theme.processor";

const ENSURERS: Record<string, (job: MigrationJobWithConnection) => Promise<void>> = {
  files: ensureFileItems,
  metafield_definitions: ensureMetafieldDefinitionItems,
  metaobject_definitions: ensureMetaobjectDefinitionItems,
  products: ensureProductItems,
  images: ensureImageItems,
  inventory: ensureInventoryItems,
  collections: ensureCollectionItems,
  customers: ensureCustomerItems,
  pages: ensurePageItems,
  blogs: ensureBlogItems,
  menus: ensureMenuItems,
  metaobjects: ensureMetaobjectEntryItems,
  discounts: ensureDiscountItems,
  orders: ensureOrderItems,
  theme: ensureThemeItems,
};

const EXPORT_ORDER = [
  "files", "metafield_definitions", "metaobject_definitions", "products", "images",
  "inventory", "collections", "customers", "pages", "blogs", "menus", "metaobjects",
  "discounts", "orders", "theme",
];

export const MIGRATION_PACKAGE_VERSION = 1;
export const MAX_MIGRATION_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_UNPACKED_PACKAGE_BYTES = 300 * 1024 * 1024;
const MAX_PACKAGE_ITEMS = 100_000;

const RESOURCE_ITEM_TYPES: Record<string, string[]> = {
  files: ["file"],
  metafield_definitions: ["metafield_definition"],
  metaobject_definitions: ["metaobject_definition"],
  products: ["product", "variant"],
  images: ["image"],
  inventory: ["inventory"],
  collections: ["collection"],
  customers: ["customer"],
  pages: ["page"],
  blogs: ["blog", "article"],
  menus: ["menu"],
  metaobjects: ["metaobject"],
  discounts: ["discount"],
  orders: ["order"],
  theme: ["theme"],
};

const ITEM_STAGE: Record<string, string> = Object.fromEntries(
  Object.entries(RESOURCE_ITEM_TYPES).flatMap(([stage, types]) =>
    types.map((type) => [type, stage]),
  ),
);

type PackageItem = {
  resourceType: string;
  stage: string;
  sourceId: string;
  payload: object | null;
};

export type MigrationPackageManifest = {
  format: "duplify-migration-package";
  version: number;
  createdAt: string;
  sourceShop: string;
  selectedResources: string[];
  conflictStrategy: Record<string, string>;
  counts: Record<string, number>;
};

type ThemeFile = { filename: string; bodyType: "TEXT" | "BASE64" | "URL"; value: string };

export async function prepareMigrationPackage(job: MigrationJobWithConnection): Promise<Uint8Array> {
  const selectedResources = Array.isArray(job.selectedResources)
    ? job.selectedResources.filter((value): value is string => typeof value === "string")
    : [];
  const conflictStrategy = isRecord(job.conflictStrategy)
    ? Object.fromEntries(
        Object.entries(job.conflictStrategy).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};
  for (const resource of EXPORT_ORDER) {
    if (!selectedResources.includes(resource)) continue;
    const ensure = ENSURERS[resource];
    if (ensure) await ensure(job);
  }

  const items = await db.migrationItem.findMany({
    where: { migrationJobId: job.id },
    orderBy: { createdAt: "asc" },
    select: { resourceType: true, stage: true, sourceId: true, payload: true },
  });

  const packagedItems: PackageItem[] = [];
  for (const item of items) {
    let payload = item.payload as object | null;
    if (item.resourceType === "theme" && payload) {
      payload = await makeThemePayloadPortable(payload as { themeName?: string; files?: ThemeFile[] });
    }
    packagedItems.push({ ...item, payload });
  }

  const archive: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify({
      format: "duplify-migration-package",
      version: MIGRATION_PACKAGE_VERSION,
      createdAt: new Date().toISOString(),
      sourceShop: job.storeConnection.sourceShop.shopDomain,
      selectedResources,
      conflictStrategy,
      counts: packagedItems.reduce<Record<string, number>>((counts, item) => {
        counts[item.resourceType] = (counts[item.resourceType] ?? 0) + 1;
        return counts;
      }, {}),
    } satisfies MigrationPackageManifest, null, 2)),
  };
  for (const resource of EXPORT_ORDER) {
    const acceptedTypes = new Set(RESOURCE_ITEM_TYPES[resource] ?? []);
    const resourceItems = packagedItems.filter((item) => acceptedTypes.has(item.resourceType));
    if (resourceItems.length > 0) archive[`data/${resource}.json`] = strToU8(JSON.stringify(resourceItems));
  }
  return zipSync(archive, { level: 6 });
}

function decodeBase64(value: string): Uint8Array {
  const binary = Buffer.from(value, "base64");
  return new Uint8Array(binary);
}

async function makeThemePayloadPortable(payload: { themeName?: string; files?: ThemeFile[] }) {
  const files: ThemeFile[] = [];
  for (const file of payload.files ?? []) {
    if (file.bodyType !== "URL") {
      files.push(file);
      continue;
    }
    const response = await fetch(file.value);
    if (!response.ok) throw new Error(`Could not package theme file ${file.filename}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    files.push({ ...file, bodyType: "BASE64", value: Buffer.from(bytes).toString("base64") });
  }
  return { ...payload, files };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseMigrationPackage(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_MIGRATION_PACKAGE_BYTES) {
    throw new Error("Migration package is larger than 100 MB.");
  }
  const files = unzipSync(bytes);
  const unpackedBytes = Object.values(files).reduce((sum, file) => sum + file.byteLength, 0);
  if (unpackedBytes > MAX_UNPACKED_PACKAGE_BYTES) {
    throw new Error("Unpacked migration package is larger than 300 MB.");
  }
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw new Error("Migration package manifest is missing.");
  const manifest = JSON.parse(strFromU8(manifestBytes)) as MigrationPackageManifest;
  if (
    manifest.format !== "duplify-migration-package" ||
    manifest.version !== MIGRATION_PACKAGE_VERSION ||
    typeof manifest.sourceShop !== "string" ||
    !Array.isArray(manifest.selectedResources) ||
    !isRecord(manifest.conflictStrategy)
  ) {
    throw new Error("Invalid migration package manifest");
  }
  const allowedResources = new Set(EXPORT_ORDER);
  if (manifest.selectedResources.some((resource) => !allowedResources.has(resource))) {
    throw new Error("Migration package contains an unsupported resource.");
  }

  const items: PackageItem[] = [];
  for (const resource of manifest.selectedResources) {
    const entry = files[`data/${resource}.json`];
    if (!entry) continue;
    const rows = JSON.parse(strFromU8(entry)) as unknown;
    if (!Array.isArray(rows)) throw new Error(`Invalid ${resource} data in migration package.`);
    const acceptedTypes = new Set(RESOURCE_ITEM_TYPES[resource] ?? []);
    for (const row of rows) {
      if (
        !isRecord(row) ||
        typeof row.resourceType !== "string" ||
        !acceptedTypes.has(row.resourceType) ||
        typeof row.sourceId !== "string" ||
        row.sourceId.length === 0 ||
        (row.payload !== null && !isRecord(row.payload))
      ) {
        throw new Error(`Invalid ${resource} record in migration package.`);
      }
      items.push({
        resourceType: row.resourceType,
        stage: ITEM_STAGE[row.resourceType],
        sourceId: row.sourceId,
        payload: (row.payload as object | null) ?? null,
      });
      if (items.length > MAX_PACKAGE_ITEMS) throw new Error("Migration package contains too many records.");
    }
  }
  if (items.length === 0) throw new Error("Migration package contains no data");
  return { manifest, items };
}
