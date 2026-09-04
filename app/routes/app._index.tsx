import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  redirect,
  useFetcher,
  useLoaderData,
  useRevalidator,
  useSearchParams,
} from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  hydrateShopFromOfflineSession,
  listConnectionsForOwner,
  refreshShopScopesIfStale,
} from "../lib/services/storeConnection.service";
import { createMigrationJob } from "../lib/services/migrationJob.service";
import { countLiveMissingPermissions, scanSummaryLooksBlocked } from "../lib/services/permissionStatus.server";
import { shopIsConnected } from "../lib/shopify/scopes";
import type { ConflictStrategy } from "../lib/services/types";
import { StatCard } from "../components/dashboard/StatCard";
import { StatusBadge } from "../components/dashboard/StatusBadge";
import { HeroBanner } from "../components/dashboard/HeroBanner";
import { MigrationList } from "../components/dashboard/MigrationList";
import { EmptyState } from "../components/shared/EmptyState";

// Theme migration is enabled for full-copy flows once the Shopify theme
// exemption is in place. The app already handles the theme export/import flow
// and creates unpublished destination themes automatically when needed.
const THEME_MIGRATION_ENABLED = true;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    return {
      currentShopDomain: session.shop,
      connections: [],
      jobs: [],
      stats: { active: 0, completed: 0, failed: 0 },
    };
  }

  const connections = await listConnectionsForOwner(shop.id);

  // Best-effort heal only — never crash Overview if Session/token sync fails.
  try {
    await Promise.all(
      connections.flatMap((connection) => [
        hydrateShopFromOfflineSession(connection.sourceShop.shopDomain)
          .then(async (hydrated) => {
            if (hydrated) await refreshShopScopesIfStale(hydrated);
          })
          .catch(() => undefined),
        hydrateShopFromOfflineSession(connection.destinationShop.shopDomain)
          .then(async (hydrated) => {
            if (hydrated) await refreshShopScopesIfStale(hydrated);
          })
          .catch(() => undefined),
      ]),
    );
  } catch {
    // Ignore heal failures — READY pairs still proceed without banners.
  }

  const refreshedConnections = await listConnectionsForOwner(shop.id);

  const shopConnectionAccess = {
    ownerShopId: shop.id,
  };

  const rawJobs = await db.migrationJob.findMany({
    where: { storeConnection: shopConnectionAccess },
    include: {
      storeConnection: { include: { sourceShop: true, destinationShop: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const jobs = collapseDuplicateBlockedScans(rawJobs).slice(0, 5);

  const [active, completed, failed] = await Promise.all([
    db.migrationJob.count({
      where: {
        storeConnection: shopConnectionAccess,
        status: { in: ["QUEUED", "RUNNING", "SCANNING"] },
      },
    }),
    db.migrationJob.count({
      where: { storeConnection: shopConnectionAccess, status: "COMPLETED" },
    }),
    db.migrationJob.count({
      where: { storeConnection: shopConnectionAccess, status: "FAILED" },
    }),
  ]);

  return {
    currentShopDomain: session.shop,
    connections: refreshedConnections.map((c) => ({
      id: c.id,
      source: c.sourceShop.shopDomain,
      destination: c.destinationShop.shopDomain,
      status: c.status,
      // READY pair = no install/permission banners. Keep UX simple for clients.
      sourceInstalled: true,
      destinationInstalled: true,
      sourceMissingScopes: [] as string[],
      destinationMissingScopes: [] as string[],
    })),
    jobs: jobs.map((j) => {
      const sourceConnected = shopIsConnected(j.storeConnection.sourceShop);
      const destinationConnected = shopIsConnected(
        j.storeConnection.destinationShop,
      );
      // Stale scan summaries can say "reconnect" even after the store is live
      // again — only show that warning when the source is actually disconnected.
      const scanBlocked =
        scanSummaryLooksBlocked(j.scanSummary) && !sourceConnected;
      return {
        id: j.id,
        type: j.type,
        status: j.status,
        source: j.storeConnection.sourceShop.shopDomain,
        destination: j.storeConnection.destinationShop.shopDomain,
        totalRecords: j.totalRecords,
        completedRecords: j.completedRecords,
        missingPermissionsCount: countMissingPermissions(j, {
          sourceConnected,
          destinationConnected,
        }),
        scanBlocked,
        createdAt: j.createdAt,
      };
    }),
    stats: { active, completed, failed },
  };
};

function countMissingPermissions(
  job: {
    selectedResources: unknown;
    storeConnection: {
      sourceShop: { scope: string; shopDomain: string };
      destinationShop: { scope: string; shopDomain: string };
    };
  },
  connected?: { sourceConnected: boolean; destinationConnected: boolean },
) {
  return countLiveMissingPermissions(normalizeStrings(job.selectedResources), {
    sourceScope: job.storeConnection.sourceShop.scope,
    destinationScope: job.storeConnection.destinationShop.scope,
    sourceShopDomain: job.storeConnection.sourceShop.shopDomain,
    destinationShopDomain: job.storeConnection.destinationShop.shopDomain,
    sourceConnected: connected?.sourceConnected,
    destinationConnected: connected?.destinationConnected,
  });
}

function collapseDuplicateBlockedScans<
  T extends {
    status: string;
    storeConnectionId: string;
    type: string;
    totalRecords: number;
    selectedResources: unknown;
    scanSummary: unknown;
    storeConnection: {
      sourceShop: {
        scope: string;
        shopDomain: string;
        isActive: boolean;
        accessTokenEncrypted: string | null;
        uninstalledAt: Date | null;
      };
      destinationShop: {
        scope: string;
        shopDomain: string;
        isActive: boolean;
        accessTokenEncrypted: string | null;
        uninstalledAt: Date | null;
      };
    };
  },
>(jobs: T[]) {
  const seen = new Set<string>();

  return jobs.filter((job) => {
    const sourceConnected = shopIsConnected(job.storeConnection.sourceShop);
    const destinationConnected = shopIsConnected(
      job.storeConnection.destinationShop,
    );
    const missingPermissionsCount = countMissingPermissions(job, {
      sourceConnected,
      destinationConnected,
    });
    const isBlockedScan =
      job.status === "SCANNED" &&
      job.totalRecords === 0 &&
      missingPermissionsCount > 0;

    if (!isBlockedScan) return true;

    const key = [
      job.storeConnectionId,
      job.type,
      normalizeStrings(job.selectedResources).join("|"),
    ].join(":");

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeStrings(value: unknown) {
  return Array.isArray(value) ? value.map(String).sort() : [];
}

function stableRecordString(value: Record<string, string>) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

function sameMigrationConfig(
  candidate: { selectedResources: unknown; conflictStrategy: unknown },
  selectedResources: string[],
  conflictStrategy: Record<string, string>,
) {
  const candidateResources = normalizeStrings(candidate.selectedResources);
  const resources = normalizeStrings(selectedResources);
  if (candidateResources.join("\n") !== resources.join("\n")) return false;

  const candidateStrategy =
    candidate.conflictStrategy &&
    typeof candidate.conflictStrategy === "object" &&
    !Array.isArray(candidate.conflictStrategy)
      ? (candidate.conflictStrategy as Record<string, string>)
      : {};

  return (
    stableRecordString(candidateStrategy) ===
    stableRecordString(conflictStrategy)
  );
}

const ALL_RESOURCES = [
  "files",
  "metafield_definitions",
  "metaobject_definitions",
  "products",
  "images",
  "inventory",
  "collections",
  "customers",
  "pages",
  "blogs",
  "menus",
  "metaobjects",
  "theme",
  "discounts",
  "orders",
];

const TYPE_TO_RESOURCES: Record<string, string[]> = {
  FULL: ALL_RESOURCES,
  // Product metadata is part of a complete product copy. Definitions and
  // metaobject entries are included automatically so merchants do not end up
  // with a visible metafield definition but an empty reference value.
  PRODUCTS: [
    "metafield_definitions",
    "metaobject_definitions",
    "products",
    "images",
    "inventory",
    "metaobjects",
  ],
  COLLECTIONS: ["collections"],
  CUSTOMERS: ["customers"],
  CONTENT: ["pages", "blogs", "files", "menus"],
  THEME: ["theme"],
  CUSTOM: [],
};

function includeProductMetadata(resources: string[]): string[] {
  if (!resources.includes("products")) return resources;
  return Array.from(new Set([
    ...resources,
    "metafield_definitions",
    "metaobject_definitions",
    "metaobjects",
  ]));
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });
  const form = await request.formData();

  const storeConnectionId = String(form.get("storeConnectionId") ?? "");
  const type = String(form.get("type") ?? "PRODUCTS");
  const conflictStrategy = String(
    form.get("conflictStrategy") ?? "OVERWRITE",
  ) as ConflictStrategy;
  const themeSourceId = String(form.get("themeSourceId") ?? "");

  let selectedResources: string[];
  if (type === "CUSTOM") {
    selectedResources = form.getAll("resources").map(String);
  } else {
    selectedResources = TYPE_TO_RESOURCES[type] ?? [];
  }
  selectedResources = includeProductMetadata(selectedResources);

  if (!storeConnectionId || selectedResources.length === 0) {
    return {
      error: "Choose a store pair and at least one resource to migrate.",
    };
  }

  // These resources rely on IDs created by an earlier stage. Rejecting an
  // invalid custom selection is safer than silently completing an empty copy.
  const missingDependencies: Array<{ resource: string; requires: string }> = [
    { resource: "images", requires: "products" },
    { resource: "inventory", requires: "products" },
    { resource: "metaobjects", requires: "metaobject_definitions" },
  ].filter(
    ({ resource, requires }) =>
      selectedResources.includes(resource) &&
      !selectedResources.includes(requires),
  );
  if (missingDependencies.length > 0) {
    return {
      error: missingDependencies
        .map(
          ({ resource, requires }) =>
            `${resource.replace(/_/g, " ")} requires ${requires.replace(/_/g, " ")}`,
        )
        .join(". "),
    };
  }

  const connection = await db.storeConnection.findFirst({
    where: {
      id: storeConnectionId,
      ownerShopId: shop.id,
      status: "READY",
    },
    include: { sourceShop: true, destinationShop: true },
  });
  if (!connection) {
    return { error: "Choose a valid connected store pair." };
  }

  // Never block scan start with permission redirects — pair is already connected.
  try {
    await Promise.all([
      hydrateShopFromOfflineSession(connection.sourceShop.shopDomain),
      hydrateShopFromOfflineSession(connection.destinationShop.shopDomain),
    ]);
  } catch {
    // Non-fatal
  }

  const conflictStrategyMap: Record<string, string> = Object.fromEntries(
    selectedResources.map((r) => [r, conflictStrategy]),
  );
  // Which specific source theme to export — stashed here since MigrationJob
  // has no dedicated column for it (see theme.processor.ts).
  if (selectedResources.includes("theme") && themeSourceId) {
    conflictStrategyMap.__themeSourceId = themeSourceId;
  }

  const reusableJobs = await db.migrationJob.findMany({
    where: {
      storeConnectionId,
      type: type as never,
      status: { in: ["DRAFT", "SCANNING", "SCANNED"] },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const reusableJob = reusableJobs.find((candidate) =>
    sameMigrationConfig(candidate, selectedResources, conflictStrategyMap),
  );
  if (reusableJob) {
    return redirect(`/app/migrations/${reusableJob.id}/scan`);
  }

  const job = await createMigrationJob({
    storeConnectionId,
    type: type as never,
    selectedResources,
    conflictStrategy: conflictStrategyMap,
  });

  return redirect(`/app/migrations/${job.id}/scan`);
};

const MIGRATION_TYPES: Array<{
  value: string;
  label: string;
  supported: boolean;
}> = [
  { value: "FULL", label: "Full store migration", supported: true },
  {
    value: "PRODUCTS",
    label: "Products (variants, images, inventory & metadata)",
    supported: true,
  },
  { value: "COLLECTIONS", label: "Collections only", supported: true },
  {
    value: "CUSTOMERS",
    label: "Customers only (protected data access required)",
    supported: true,
  },
  {
    value: "CONTENT",
    label: "Content only (pages, blogs, files, menus)",
    supported: true,
  },
  {
    value: "THEME",
    label: "Theme only",
    supported: THEME_MIGRATION_ENABLED,
  },
  { value: "CUSTOM", label: "Custom selection", supported: true },
];

const CUSTOM_RESOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "files", label: "Files" },
  { value: "metafield_definitions", label: "Metafield definitions" },
  { value: "metaobject_definitions", label: "Metaobject definitions" },
  { value: "products", label: "Products & variants" },
  { value: "images", label: "Product images" },
  { value: "inventory", label: "Inventory levels" },
  { value: "collections", label: "Collections" },
  { value: "customers", label: "Customers (protected data access required)" },
  { value: "pages", label: "Pages" },
  { value: "blogs", label: "Blogs & articles" },
  { value: "menus", label: "Menus" },
  { value: "metaobjects", label: "Metaobject entries" },
  { value: "theme", label: "Theme files" },
  { value: "discounts", label: "Discounts (basic codes only)" },
  { value: "orders", label: "Orders (recreated as draft orders)" },
];

interface SourceTheme {
  id: string;
  name: string;
  role: string;
}

const LIMITATIONS_BANNER_DISMISSED_KEY = "duplify-limitations-banner-dismissed";

export default function Overview() {
  const { connections, jobs, stats } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const readyConnections = connections.filter((c) => c.status === "READY");
  const hasReadyConnection = readyConnections.length > 0;
  const hasLiveJobs = jobs.some((job) =>
    ["SCANNING", "QUEUED", "RUNNING"].includes(job.status),
  );
  const packageError = searchParams.get("packageError");

  const [storeConnectionId, setStoreConnectionId] = useState(
    searchParams.get("connectionId") ?? readyConnections[0]?.id ?? "",
  );
  const [type, setType] = useState("PRODUCTS");
  const [resources, setResources] = useState<string[]>(["products", "images"]);
  const [limitationsDismissed, setLimitationsDismissed] = useState(false);
  const [themeSourceId, setThemeSourceId] = useState("");

  useEffect(() => {
    if (!connections.some((connection) => connection.status === "PENDING")) {
      return;
    }
    const timer = window.setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [connections, revalidator]);

  useEffect(() => {
    if (!storeConnectionId && readyConnections[0]) {
      setStoreConnectionId(readyConnections[0].id);
    }
  }, [readyConnections, storeConnectionId]);

  const selectedResources = includeProductMetadata(
    type === "CUSTOM" ? resources : (TYPE_TO_RESOURCES[type] ?? []),
  );
  // READY pairs are never blocked by install/permission banners on Overview.
  // Scan/import itself enforces real Shopify access; this UI was causing false blocks.
  const hasThemeLimitation = selectedResources.includes("theme");
  const hasDiscountLimitation = selectedResources.includes("discounts");
  const hasOrderLimitation = selectedResources.includes("orders");
  const showLimitationsBanner =
    !limitationsDismissed &&
    (type === "FULL" ||
      hasThemeLimitation ||
      hasDiscountLimitation ||
      hasOrderLimitation);
  const limitationsHeading =
    type === "FULL" ? "Full store — important limitations" : "Migration limitations";
  const needsThemePicker = hasThemeLimitation;

  const themesFetcher = useFetcher<{
    themes: SourceTheme[];
    missingScopes?: string[];
    error?: string;
  }>();

  useEffect(() => {
    setLimitationsDismissed(
      window.localStorage.getItem(LIMITATIONS_BANNER_DISMISSED_KEY) === "true",
    );
  }, []);

  useEffect(() => {
    if (!hasLiveJobs) return;
    const interval = setInterval(() => revalidator.revalidate(), 2500);
    return () => clearInterval(interval);
  }, [hasLiveJobs, revalidator]);

  useEffect(() => {
    if (!needsThemePicker || !storeConnectionId) return;
    themesFetcher.load(`/api/connections/${storeConnectionId}/themes`);
    // Load once per connection/type — do not depend on fetcher identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsThemePicker, storeConnectionId]);

  useEffect(() => {
    const themes = themesFetcher.data?.themes;
    if (themes && themes.length > 0 && !themeSourceId) {
      setThemeSourceId(
        themes.find((t) => t.role === "MAIN")?.id ?? themes[0].id,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themesFetcher.data]);

  function dismissLimitationsBanner() {
    setLimitationsDismissed(true);
    window.localStorage.setItem(LIMITATIONS_BANNER_DISMISSED_KEY, "true");
  }

  return (
    <s-page heading="Overview" inlineSize="large">
      {!hasReadyConnection && (
        <s-button slot="primary-action" href="/app/connect" variant="primary">
          Connect stores
        </s-button>
      )}

      <HeroBanner
        heading="Welcome to Duplify Store"
        subheading="Connect a source and destination store, then migrate products, variants, images and collections with full tracking and retry."
        stats={[
          { label: "Store pairs", value: connections.length },
          {
            label: "Migrations run",
            value: stats.active + stats.completed + stats.failed,
          },
        ]}
      />

      <s-section heading="At a glance">
        <s-stack direction="inline" gap="base">
          <StatCard
            label="Active migrations"
            value={stats.active}
            tone="info"
          />
          <StatCard
            label="Completed migrations"
            value={stats.completed}
            tone="success"
          />
          <StatCard
            label="Failed migrations"
            value={stats.failed}
            tone={stats.failed > 0 ? "critical" : "neutral"}
          />
        </s-stack>
      </s-section>

      {hasReadyConnection && (
        <s-section id="start-migration" heading="Start migration">
          <Form method="post">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Choose a connected store pair, select what to copy, then run the
                scan. Connected pairs are ready to scan — no extra install step.
              </s-paragraph>
              {!THEME_MIGRATION_ENABLED && (
                <s-banner
                  tone="warning"
                  heading="Theme migration is temporarily unavailable"
                >
                  <s-paragraph>
                    Shopify must approve Duplify’s protected theme permission
                    before a public app can create or edit an unpublished
                    theme. Full store migration currently excludes theme files;
                    other store data can still migrate.
                  </s-paragraph>
                  <s-button
                    slot="secondary-actions"
                    href="/app/documentation#theme-migration"
                    variant="secondary"
                  >
                    Learn why
                  </s-button>
                </s-banner>
              )}
              <s-select
                name="storeConnectionId"
                label="Store pair"
                value={storeConnectionId}
                onChange={(e) => {
                  setStoreConnectionId(e.currentTarget.value);
                  setThemeSourceId("");
                }}
              >
                <s-option value="" disabled>
                  Select store pair
                </s-option>
                {readyConnections.map((c) => (
                  <s-option key={c.id} value={c.id}>
                    {c.source} → {c.destination}
                  </s-option>
                ))}
              </s-select>

              <s-select
                name="type"
                label="Migration type"
                value={type}
                onChange={(e) => {
                  setType(e.currentTarget.value);
                  setThemeSourceId("");
                }}
              >
                {MIGRATION_TYPES.filter((t) => t.supported).map((t) => (
                  <s-option key={t.value} value={t.value}>
                    {t.label}
                  </s-option>
                ))}
              </s-select>

              {type === "CUSTOM" && (
                <s-choice-list
                  name="resources"
                  label="Resources"
                  multiple
                  values={resources}
                  onChange={(e) => {
                    const values = (e.target as unknown as { values: string[] })
                      .values;
                    setResources(values);
                  }}
                >
                  {CUSTOM_RESOURCE_OPTIONS.map((r) => (
                    <s-choice key={r.value} value={r.value}>
                      {r.label}
                    </s-choice>
                  ))}
                </s-choice-list>
              )}

              {needsThemePicker && (
                <s-select
                  name="themeSourceId"
                  label="Which theme to export"
                  details={
                    themesFetcher.state === "loading" ||
                    themesFetcher.state === "submitting"
                      ? "Loading themes from source store…"
                      : themesFetcher.data?.missingScopes?.length
                        ? "Source store needs theme access — open Duplify once on the source store, then refresh."
                        : themesFetcher.data?.error
                          ? themesFetcher.data.error
                          : themesFetcher.data &&
                              (themesFetcher.data.themes?.length ?? 0) === 0
                            ? "No themes found on the source store."
                            : "Leave as live theme, or pick another source theme."
                  }
                  value={themeSourceId}
                  onChange={(e) => setThemeSourceId(e.currentTarget.value)}
                >
                  <s-option value="">
                    Live / published theme (default)
                  </s-option>
                  {(themesFetcher.data?.themes ?? []).map((t) => (
                    <s-option key={t.id} value={t.id}>
                      {t.name}{" "}
                      {t.role === "MAIN"
                        ? "(live)"
                        : `(${t.role.toLowerCase()})`}
                    </s-option>
                  ))}
                </s-select>
              )}

              {showLimitationsBanner && (
                <s-banner tone="info" heading={limitationsHeading}>
                  <s-stack direction="block" gap="small-200">
                    {type === "FULL" && (
                      <>
                        <s-paragraph>
                          Passwords, payment gateways, staff accounts, domains,
                          and app subscriptions are never copied.
                        </s-paragraph>
                        {!THEME_MIGRATION_ENABLED && (
                          <s-paragraph>
                            Theme files are not included while Shopify approval
                            for theme migration is pending.
                          </s-paragraph>
                        )}
                        <s-paragraph>
                          Product drafts and unpublished content copy only when
                          selected resources include them; metafield{" "}
                          <s-text type="strong">values</s-text> on resources
                          migrate with those resources, but some app-owned
                          definitions cannot be recreated.
                        </s-paragraph>
                      </>
                    )}
                    {hasThemeLimitation && (
                      <s-paragraph>
                        Theme files are copied to an unpublished theme on the
                        destination (created automatically if needed). Publish
                        it from Online Store → Themes when you are ready. Only
                        migrate themes you are licensed to use.
                      </s-paragraph>
                    )}
                    {hasDiscountLimitation && (
                      <s-paragraph>
                        Only basic percentage and fixed-amount discount codes
                        migrate right now.
                      </s-paragraph>
                    )}
                    {hasOrderLimitation && (
                      <s-paragraph>
                        Orders are recreated as draft orders. Shopify returns
                        only the most recent 60 days until read_all_orders
                        access is approved for this app; original order numbers,
                        timestamps, payment state, and fulfillment state do not
                        transfer.
                      </s-paragraph>
                    )}
                  </s-stack>
                  <s-button
                    slot="secondary-actions"
                    href="/app/documentation"
                    variant="secondary"
                  >
                    Documentation
                  </s-button>
                  <s-button
                    slot="secondary-actions"
                    variant="tertiary"
                    onClick={dismissLimitationsBanner}
                  >
                    Dismiss
                  </s-button>
                </s-banner>
              )}

              <s-select
                name="conflictStrategy"
                label="If a record already exists on the destination store"
                value="OVERWRITE"
              >
                <s-option value="" disabled>
                  Select conflict handling
                </s-option>
                <s-option value="OVERWRITE">Overwrite it (recommended for full copy)</s-option>
                <s-option value="SKIP">Skip it</s-option>
                <s-option value="CREATE_NEW">Create a new copy</s-option>
              </s-select>

              <s-button type="submit" variant="primary">
                Run pre-migration scan
              </s-button>
            </s-stack>
          </Form>
        </s-section>
      )}

      {hasReadyConnection && (
        <s-section heading="Import a migration package">
          <Form
            method="post"
            action="/api/migrations/import"
            encType="multipart/form-data"
          >
            <s-stack direction="block" gap="base">
              {packageError && (
                <s-banner tone="critical" heading="Package could not be imported">
                  <s-paragraph>{packageError}</s-paragraph>
                </s-banner>
              )}
              <s-paragraph>
                Upload a Duplify ZIP exported from the source store. We validate it,
                then import its records into the destination store in migration order.
              </s-paragraph>
              <label>
                Destination store pair
                <select name="storeConnectionId" defaultValue={readyConnections[0]?.id} required>
                  {readyConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.source} → {connection.destination}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Migration package ZIP
                <input name="package" type="file" accept=".zip,application/zip" required />
              </label>
              <s-paragraph color="subdued">
                Packages can contain customer personal data. Keep the ZIP private and
                delete it after the migration is verified. Maximum size: 100 MB.
              </s-paragraph>
              <s-button type="submit" variant="primary">
                Validate and import ZIP
              </s-button>
            </s-stack>
          </Form>
        </s-section>
      )}

      <s-section heading="Connected store pairs">
        {connections.length === 0 ? (
          <EmptyState
            heading="No stores connected yet"
            message="Connect a source and destination store to start your first migration."
            action={{ label: "Connect stores", href: "/app/connect" }}
          />
        ) : (
          <div style={{ display: "grid", gap: "8px" }}>
            {connections.map((c) => (
              <div
                key={c.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "12px",
                  flexWrap: "wrap",
                  padding: "12px 14px",
                  border: "1px solid #dcdfe4",
                  borderRadius: "8px",
                  background: "#ffffff",
                }}
              >
                <span
                  style={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "#202223",
                  }}
                  title={`${c.source} -> ${c.destination}`}
                >
                  {c.source} &rarr; {c.destination}
                </span>
                <StatusBadge status={c.status} />
              </div>
            ))}
          </div>
        )}
      </s-section>

      <s-section heading="Recent migrations">
        {jobs.length === 0 ? (
          <s-paragraph>No migrations yet.</s-paragraph>
        ) : (
          <MigrationList jobs={jobs} />
        )}
      </s-section>

      <s-section slot="aside" heading="How Duplify Store works">
        <s-unordered-list>
          <s-list-item>
            Connect your source and destination stores via OAuth
          </s-list-item>
          <s-list-item>
            Choose what to migrate and run a pre-migration scan
          </s-list-item>
          <s-list-item>Review conflicts and start the migration</s-list-item>
          <s-list-item>
            Track progress and retry anything that fails
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}
