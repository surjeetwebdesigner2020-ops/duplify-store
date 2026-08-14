import { useId, useState } from "react";
import { useFetcher, useLocation } from "react-router";
import { isRequestableScope } from "../../lib/shopify/scopes";

interface PermissionBannerProps {
  missing: Array<{
    resourceType: string;
    missing: string[];
    shopRole?: "source" | "destination";
    shopDomain?: string;
    installed?: boolean;
  }>;
  authorizeHref: string;
  currentShopDomain?: string;
}

function sameShop(a?: string, b?: string) {
  if (!a || !b) return false;
  return (
    a.replace(/\.myshopify\.com$/i, "").toLowerCase() ===
    b.replace(/\.myshopify\.com$/i, "").toLowerCase()
  );
}

export function PermissionBanner({
  missing,
  currentShopDomain,
}: PermissionBannerProps) {
  const location = useLocation();
  const scopesFetcher = useFetcher();
  const isUpdating = scopesFetcher.state !== "idle";
  const installModalId = useId().replace(/:/g, "");
  const [copied, setCopied] = useState(false);

  // If the merchant is already inside a shop's Duplify app, that shop is
  // installed — never ask them to "Install" it again.
  const effectiveMissing = missing
    .map((item) => {
      if (sameShop(currentShopDomain, item.shopDomain)) {
        return { ...item, installed: true, missing: [] as string[] };
      }
      // Connected/installed shops should not block with permission spam.
      if (item.installed) {
        return { ...item, missing: [] as string[] };
      }
      return item;
    })
    .filter((item) => item.missing.length > 0);

  const hasMissingPermissions = effectiveMissing.some(
    (m) => m.missing.length > 0,
  );
  if (!hasMissingPermissions) return null;

  const sourceEntry = effectiveMissing.find((m) => m.shopRole === "source");
  const destinationEntry = effectiveMissing.find(
    (m) => m.shopRole !== "source",
  );
  const sourceShopDomain = sourceEntry?.shopDomain;
  const destinationShopDomain = destinationEntry?.shopDomain;
  const sourceInstalled = sourceEntry ? sourceEntry.installed !== false : true;
  const sourceNeedsInstall = Boolean(
    sourceEntry?.missing.length && !sourceInstalled,
  );
  const sourceNeedsPermissions = Boolean(
    sourceEntry?.missing.length && sourceInstalled,
  );
  const destinationNeedsPermissions = Boolean(
    destinationEntry?.missing.length,
  );
  const sourceIsCurrent = sameShop(currentShopDomain, sourceShopDomain);
  const destinationIsCurrent = sameShop(
    currentShopDomain,
    destinationShopDomain,
  );

  const currentStoreScopes = Array.from(
    new Set(
      effectiveMissing
        .filter((item) => sameShop(currentShopDomain, item.shopDomain))
        .flatMap((item) => item.missing)
        .filter((scope) => scope !== "reconnect" && isRequestableScope(scope)),
    ),
  );

  const otherShopDomain = sourceIsCurrent
    ? destinationNeedsPermissions
      ? destinationShopDomain
      : undefined
    : destinationIsCurrent
      ? sourceNeedsInstall || sourceNeedsPermissions
        ? sourceShopDomain
        : undefined
      : (sourceShopDomain ?? destinationShopDomain);

  const otherShopHandle = otherShopDomain
    ?.replace(/\.myshopify\.com$/i, "")
    .trim();
  const otherShopHref = otherShopHandle
    ? `https://admin.shopify.com/store/${otherShopHandle}/apps/duplify-store`
    : undefined;
  const installHref = sourceShopDomain
    ? `https://admin.shopify.com/store/${sourceShopDomain.replace(/\.myshopify\.com$/i, "")}/apps/duplify-store`
    : undefined;

  function requestCurrentScopes() {
    if (currentStoreScopes.length === 0 || isUpdating) return;
    const data = new FormData();
    for (const scope of currentStoreScopes) {
      data.append("scopes", scope);
    }
    data.set("returnTo", `${location.pathname}${location.search}`);
    scopesFetcher.submit(data, {
      method: "post",
      action: "/api/scopes/request",
    });
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      const input = document.getElementById(
        `${installModalId}-url`,
      ) as HTMLInputElement | null;
      input?.select();
    }
  }

  const needsReconnect = effectiveMissing.some((item) =>
    item.missing.includes("reconnect"),
  );

  const heading = sourceNeedsInstall || needsReconnect
    ? "Open Duplify on the source store once"
    : "Store update needed";

  const message =
    sourceNeedsInstall || needsReconnect
      ? sourceShopDomain
        ? `Open Duplify once on ${sourceShopDomain} so access syncs. Then return here and run the scan again. No extra permission grant is needed after a normal install.`
        : "Open Duplify once on the source store so access syncs, then run the scan again."
      : "Update this store's access before importing can start.";

  const modalUrl = installHref ?? otherShopHref;

  return (
    <>
      <s-banner tone="warning" heading={heading}>
        <s-stack direction="block" gap="base">
          <s-paragraph>{message}</s-paragraph>
        </s-stack>

        {currentStoreScopes.length > 0 && !needsReconnect && (
          <s-button
            slot="primary-action"
            variant="primary"
            loading={isUpdating}
            onClick={requestCurrentScopes}
          >
            Update this store
          </s-button>
        )}

        {(sourceNeedsInstall || needsReconnect) && modalUrl && (
          <s-button
            slot={
              currentStoreScopes.length > 0 && !needsReconnect
                ? "secondary-actions"
                : "primary-action"
            }
            variant={
              currentStoreScopes.length > 0 && !needsReconnect
                ? "secondary"
                : "primary"
            }
            command="--show"
            commandFor={installModalId}
          >
            Copy source store app URL
          </s-button>
        )}
      </s-banner>

      {modalUrl && (sourceNeedsInstall || needsReconnect) && (
        <s-modal id={installModalId} heading="Open source store app">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Paste this URL in a browser signed into {sourceShopDomain}, open
              Duplify (Install only if first time), then return here and refresh.
            </s-paragraph>
            <s-text-field
              id={`${installModalId}-url`}
              label="URL"
              value={modalUrl}
              readOnly
            />
          </s-stack>
          <s-button
            slot="primary-action"
            variant="primary"
            onClick={() => {
              void copyUrl(modalUrl);
            }}
          >
            {copied ? "Copied" : "Copy URL"}
          </s-button>
          <s-button
            slot="secondary-actions"
            variant="secondary"
            href={modalUrl}
            target="_blank"
          >
            Open link
          </s-button>
          <s-button
            slot="secondary-actions"
            command="--hide"
            commandFor={installModalId}
          >
            Close
          </s-button>
        </s-modal>
      )}
    </>
  );
}
