import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  Outlet,
  isRouteErrorResponse,
  useLoaderData,
  useLocation,
  useNavigate,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { syncEmbeddedShopFromSession } from "../lib/services/storeConnection.service";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  // Keep Shop.scope / token in sync on every open — otherwise Overview keeps
  // saying "Source store needs Duplify installed" after the app is already on.
  const shop = await syncEmbeddedShopFromSession(session);
  const [ownedConnections, invitedConnections] = await Promise.all([
    db.storeConnection.count({
      where: { ownerShopId: shop.id, status: { not: "ARCHIVED" } },
    }),
    db.storeConnection.count({
      where: {
        ownerShopId: { not: shop.id },
        status: { not: "ARCHIVED" },
        OR: [{ sourceShopId: shop.id }, { destinationShopId: shop.id }],
      },
    }),
  ]);
  const isCompanion = ownedConnections === 0 && invitedConnections > 0;
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    shopDomain: session.shop,
    isCompanion,
  };
};

export default function App() {
  const { apiKey, isCompanion } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();
  const isCompanionRoute = location.pathname === "/app/connect";

  useEffect(() => {
    if (isCompanion && !isCompanionRoute) {
      navigate("/app/connect", { replace: true });
    }
  }, [isCompanion, isCompanionRoute, navigate]);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        {isCompanion ? (
          <s-link href="/app/connect">Connection request</s-link>
        ) : (
          <>
            <s-link href="/app">Overview</s-link>
            <s-link href="/app/connect">Import / Export</s-link>
            <s-link href="/app/migrations">History</s-link>
            <s-link href="/app/mappings">ID mappings</s-link>
            <s-link href="/app/documentation">Documentation</s-link>
            <s-link href="/app/settings">Settings</s-link>
          </>
        )}
      </s-app-nav>
      {(!isCompanion || isCompanionRoute) && <Outlet />}
    </AppProvider>
  );
}

function FriendlyError({ message }: { message: string }) {
  return (
    <s-page heading="Something went wrong">
      <s-banner tone="critical" heading="Could not load this page">
        <s-paragraph>{message}</s-paragraph>
        <s-button slot="primary-action" href="/app" variant="primary">
          Back to Overview
        </s-button>
      </s-banner>
    </s-page>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their
// headers are included. Shopify's default boundary rethrows normal Errors and
// can render an empty pink banner for ErrorResponses with blank bodies.
export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    if (error.data && typeof error.data === "string" && error.data.trim()) {
      return boundary.error(error);
    }
    return (
      <FriendlyError
        message={
          error.statusText ||
          `Request failed (${error.status}). Try refreshing the page.`
        }
      />
    );
  }

  if (error instanceof Error) {
    return (
      <FriendlyError
        message={error.message || "Unexpected client error. Please refresh."}
      />
    );
  }

  try {
    return boundary.error(error);
  } catch {
    return (
      <FriendlyError message="Unexpected error. Please refresh the page." />
    );
  }
}

export const headers: HeadersFunction = (headersArgs) => {
  const headers = boundary.headers(headersArgs);
  headers.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, max-age=0",
  );
  headers.set("Pragma", "no-cache");
  return headers;
};
