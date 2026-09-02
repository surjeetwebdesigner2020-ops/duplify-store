import { useEffect, useRef, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useRevalidator,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { listConnectionsForOwner } from "../lib/services/storeConnection.service";
import { StatusBadge } from "../components/dashboard/StatusBadge";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDestructiveModal } from "../components/shared/ConfirmDestructiveModal";
import type { action as installPairAction } from "./api.connections.install-pair";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });

  const connections = await listConnectionsForOwner(shop.id);
  const isCompanion =
    !connections.some((connection) => connection.ownerShopId === shop.id) &&
    connections.some((connection) => connection.ownerShopId !== shop.id);

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    currentShopId: shop.id,
    currentShopDomain: shop.shopDomain,
    isCompanion,
    connections: connections.map((c) => ({
      id: c.id,
      source: c.sourceShop.shopDomain,
      destination: c.destinationShop.shopDomain,
      status: c.status,
      ownerShopId: c.ownerShopId,
      createdAt: c.createdAt,
    })),
  };
};

export default function ConnectStores() {
  const {
    apiKey,
    currentShopId,
    currentShopDomain,
    isCompanion,
    connections,
  } =
    useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [otherShop, setOtherShop] = useState("");
  const [copiedInstallUrl, setCopiedInstallUrl] = useState(false);
  const [copiedApprovalId, setCopiedApprovalId] = useState<string | null>(null);
  // DESTINATION = import into this store; SOURCE = export from this store
  const [currentRole, setCurrentRole] = useState<"DESTINATION" | "SOURCE">(
    "DESTINATION",
  );
  const installPair = useFetcher<typeof installPairAction>();
  const decision = useFetcher<{
    ok: boolean;
    error?: string;
    connectionId?: string;
  }>();
  const isPairing = installPair.state !== "idle";
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const wasPairing = useRef(false);
  const wasDeciding = useRef(false);

  useEffect(() => {
    if (installPair.state !== "idle") {
      wasPairing.current = true;
      return;
    }
    if (!wasPairing.current || !installPair.data?.ok) return;
    wasPairing.current = false;
    setOtherShop("");
    const pending =
      "pending" in installPair.data && installPair.data.pending === true;
    shopify.toast.show(
      pending
        ? "Approval requested — open Duplify on the other store to Accept"
        : "Stores connected",
    );
    revalidator.revalidate();
  }, [installPair.state, installPair.data, revalidator, shopify]);

  useEffect(() => {
    if (decision.state !== "idle") {
      wasDeciding.current = true;
      return;
    }
    if (!wasDeciding.current || !decision.data) return;
    wasDeciding.current = false;
    if (decision.data.ok) {
      shopify.toast.show(
        isCompanion
          ? "Connection approved. Return to the main store to start migration."
          : "Connection updated",
      );
      if (decision.data.connectionId && !isCompanion) {
        navigate(
          `/app?connectionId=${decision.data.connectionId}#start-migration`,
        );
        return;
      }
      revalidator.revalidate();
    } else if (decision.data.error) {
      shopify.toast.show(decision.data.error, { isError: true });
    }
  }, [
    decision.state,
    decision.data,
    isCompanion,
    navigate,
    revalidator,
    shopify,
  ]);

  useEffect(() => {
    if (!connections.some((connection) => connection.status === "PENDING")) {
      return;
    }
    const timer = window.setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [connections, revalidator]);

  const otherHandle = otherShop
    .trim()
    .toLowerCase()
    .replace(/\.myshopify\.com$/, "");
  const otherInstallHref = otherHandle
    ? `https://admin.shopify.com/store/${otherHandle}/oauth/install?client_id=${encodeURIComponent(apiKey)}`
    : `https://admin.shopify.com/oauth/install?client_id=${encodeURIComponent(apiKey)}`;
  const installModalId = "connect-install-url-modal";

  async function copyOtherInstallUrl() {
    try {
      await navigator.clipboard.writeText(otherInstallHref);
      setCopiedInstallUrl(true);
      window.setTimeout(() => setCopiedInstallUrl(false), 2000);
    } catch {
      const input = document.getElementById(
        `${installModalId}-url`,
      ) as HTMLInputElement | null;
      input?.select();
    }
  }

  async function copyApprovalUrl(url: string, connectionId: string) {
    await navigator.clipboard.writeText(url);
    setCopiedApprovalId(connectionId);
    window.setTimeout(() => setCopiedApprovalId(null), 2000);
  }

  return (
    <s-page
      heading={isCompanion ? "Connection request" : "Import / Export"}
      inlineSize="large"
    >
      {isCompanion && (
        <s-section heading="Connection request">
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="base"
          >
            <s-stack direction="block" gap="base">
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">Review this connection request</s-text>
                <s-paragraph>
                  Source and destination stores must be different shops.
                </s-paragraph>
              </s-stack>
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <s-text color="subdued">
                  Open the main store to approve or decline this request, then
                  continue the migration setup.
                </s-text>
              </s-box>
            </s-stack>
          </s-box>
        </s-section>
      )}

      {!isCompanion && (
      <s-section heading="Connect another Shopify store">
        <s-stack direction="block" gap="base">
          <s-stack direction="block" gap="small-200">
            <s-text type="strong">1. What do you want to do?</s-text>
            <s-text color="subdued">
              Choose where this store's data should move.
            </s-text>
          </s-stack>

          <s-stack direction="inline" gap="base">
            <s-button
              variant={currentRole === "DESTINATION" ? "primary" : "secondary"}
              onClick={() => setCurrentRole("DESTINATION")}
            >
              Import into this store
            </s-button>
            <s-button
              variant={currentRole === "SOURCE" ? "primary" : "secondary"}
              onClick={() => setCurrentRole("SOURCE")}
            >
              Export from this store
            </s-button>
          </s-stack>

          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="base"
          >
            <s-text>
              {currentRole === "DESTINATION"
                ? `Data will be copied from the other store into ${currentShopDomain}.`
                : `Data will be copied from ${currentShopDomain} into the other store.`}
            </s-text>
          </s-box>

          <installPair.Form
            method="post"
            action="/api/connections/install-pair"
          >
            <input type="hidden" name="currentRole" value={currentRole} />
            <s-stack direction="block" gap="base">
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">2. Enter the other store</s-text>
                <s-text color="subdued">
                  Use its permanent Shopify address, for example
                  other-store.myshopify.com.
                </s-text>
              </s-stack>
              <s-text-field
                name="otherShopDomain"
                label="Other store domain"
                placeholder="other-store.myshopify.com"
                value={otherShop}
                onChange={(e) => setOtherShop(e.currentTarget.value)}
              ></s-text-field>

              {otherHandle && (
                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">3. Install and connect</s-text>
                  <s-text color="subdued">
                    Copy the install link, open it while signed into the other
                    store, then return here and send the request.
                  </s-text>
                  <s-button
                    variant="primary"
                    command="--show"
                    commandFor={installModalId}
                  >
                    Get install link
                  </s-button>
                </s-stack>
              )}

              {installPair.data && !installPair.data.ok && (
                <s-banner tone="critical" heading="Couldn't connect">
                  <s-paragraph>{installPair.data.error}</s-paragraph>
                  {"needsInstall" in installPair.data &&
                    installPair.data.needsInstall && (
                      <s-box paddingBlockStart="small-200">
                        <s-button
                          variant="primary"
                          command="--show"
                          commandFor={installModalId}
                        >
                          Get install link
                        </s-button>
                      </s-box>
                    )}
                </s-banner>
              )}
              {installPair.data?.ok && (
                <s-banner
                  tone="success"
                  heading={
                    "needsInstall" in installPair.data &&
                    installPair.data.needsInstall
                      ? "Install Duplify on the other store"
                      : "pending" in installPair.data &&
                          installPair.data.pending
                      ? "Waiting for the other store"
                      : "Stores connected"
                  }
                >
                  {"needsInstall" in installPair.data &&
                  installPair.data.needsInstall ? (
                    <s-stack direction="block" gap="small-200">
                      <s-text>
                        The request is saved. Share the install link with the
                        other store owner; this page will update automatically
                        after they approve.
                      </s-text>
                      <s-button
                        variant="primary"
                        command="--show"
                        commandFor={installModalId}
                      >
                        Get install link
                      </s-button>
                    </s-stack>
                  ) : "pending" in installPair.data &&
                    installPair.data.pending ? (
                    <s-paragraph>
                      Open Duplify on the other store, go to Import / Export,
                      and click Accept.
                    </s-paragraph>
                  ) : null}
                </s-banner>
              )}

              <s-button
                type="submit"
                variant="primary"
                {...(isPairing ? { loading: true } : {})}
              >
                Send connection request
              </s-button>
            </s-stack>
          </installPair.Form>
        </s-stack>
      </s-section>
      )}

      <s-section
        heading={isCompanion ? "Approve your connection" : "Connected stores"}
      >
        {connections.length === 0 ? (
          <EmptyState
            heading="No stores connected yet"
            message="Choose source and destination, then request a connection."
          />
        ) : (
          <s-stack direction="block" gap="base">
            {connections.map((c) => {
              const modalId = `disconnect-modal-${c.id}`;
              const approvalModalId = `approval-link-modal-${c.id}`;
              const canAccept =
                c.status === "PENDING" && c.ownerShopId !== currentShopId;
              const isWaiting =
                c.status === "PENDING" && c.ownerShopId === currentShopId;
              const otherStoreDomain =
                c.source === currentShopDomain ? c.destination : c.source;
              const otherStoreHandle = otherStoreDomain.replace(
                /\.myshopify\.com$/,
                "",
              );
              const otherStoreAppUrl = `https://admin.shopify.com/store/${otherStoreHandle}/apps/dublicate-store`;
              return (
                <s-box
                  key={c.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                  background="base"
                >
                  <s-stack direction="block" gap="small-300">
                    <s-grid
                      gridTemplateColumns="1fr auto"
                      gap="base"
                      alignItems="center"
                    >
                      <s-grid-item>
                        <s-stack direction="block" gap="small-300">
                          <s-heading>
                            {c.source} → {c.destination}
                          </s-heading>
                          <s-stack
                            direction="inline"
                            gap="small-300"
                            alignItems="center"
                          >
                            <StatusBadge status={c.status} />
                            {isWaiting && (
                              <s-text>
                                Approval needed from {otherStoreDomain}
                              </s-text>
                            )}
                            {canAccept && (
                              <s-text>
                                {otherStoreDomain} sent this request. Review it
                                now.
                              </s-text>
                            )}
                            {c.status === "READY" && !isCompanion && (
                              <s-link href={`/app?connectionId=${c.id}`}>
                                Start import
                              </s-link>
                            )}
                            {c.status === "READY" && isCompanion && (
                              <s-text>
                                Connected. Migration is managed from the main
                                store.
                              </s-text>
                            )}
                          </s-stack>
                        </s-stack>
                      </s-grid-item>
                      <s-grid-item>
                        <s-stack direction="inline" gap="small-200">
                          {isWaiting && (
                            <s-button
                              command="--show"
                              commandFor={approvalModalId}
                              variant="primary"
                            >
                              Share approval link
                            </s-button>
                          )}
                          {canAccept && (
                            <>
                              <decision.Form
                                method="post"
                                action={`/api/connections/${c.id}/accept`}
                              >
                                <s-button type="submit" variant="primary">
                                  Approve connection
                                </s-button>
                              </decision.Form>
                              <decision.Form
                                method="post"
                                action={`/api/connections/${c.id}/decline`}
                              >
                                <s-button type="submit" variant="secondary">
                                  Decline
                                </s-button>
                              </decision.Form>
                            </>
                          )}
                          <ConfirmDestructiveModal
                            id={modalId}
                            heading="Disconnect this store pair?"
                            message={`This won't delete anything already migrated between ${c.source} and ${c.destination}.`}
                            confirmLabel="Disconnect"
                            triggerLabel="Disconnect"
                            formAction={`/api/connections/${c.id}/disconnect`}
                          />
                          {isWaiting && (
                            <s-modal
                              id={approvalModalId}
                              heading={`Ask ${otherStoreHandle} to approve`}
                            >
                              <s-stack direction="block" gap="base">
                                <s-paragraph>
                                  Send this link to the owner of
                                  {` ${otherStoreDomain}`}. They must sign in,
                                  open Duplify, and approve the connection.
                                </s-paragraph>
                                <s-text-field
                                  label="Approval link"
                                  value={otherStoreAppUrl}
                                  readOnly
                                />
                              </s-stack>
                              <s-button
                                slot="primary-action"
                                variant="primary"
                                onClick={() => {
                                  void copyApprovalUrl(otherStoreAppUrl, c.id);
                                }}
                              >
                                {copiedApprovalId === c.id
                                  ? "Copied"
                                  : "Copy approval link"}
                              </s-button>
                              <s-button
                                slot="secondary-actions"
                                command="--hide"
                                commandFor={approvalModalId}
                              >
                                Close
                              </s-button>
                            </s-modal>
                          )}
                        </s-stack>
                      </s-grid-item>
                    </s-grid>
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>
        )}
      </s-section>

      <s-modal id={installModalId} heading="Install Duplify on the other store">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Copy this URL, paste it in a browser signed into the other store,
            Allow install, open the app once, then return here and request the
            connection. The other store must Accept before you can migrate.
          </s-paragraph>
          <s-text-field
            id={`${installModalId}-url`}
            label="Install URL"
            value={otherInstallHref}
            readOnly
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => {
            void copyOtherInstallUrl();
          }}
        >
          {copiedInstallUrl ? "Copied" : "Copy URL"}
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          command="--hide"
          commandFor={installModalId}
        >
          Close
        </s-button>
      </s-modal>
    </s-page>
  );
}
