import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { encryptToken } from "./lib/crypto/token-cipher";
import { PUBLISHED_SCOPES } from "./lib/shopify/scopes";

// Full migration scopes on every install. Railway SCOPES stays as a fallback
// allow-list; published scopes are the source of truth for what merchants grant.
const scopes = Array.from(
  new Set([
    ...(process.env.SCOPES?.split(",").map((scope) => scope.trim()).filter(Boolean) ?? []),
    ...PUBLISHED_SCOPES,
  ]),
);

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes,
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    // Fires after the embedded (destination) shop completes OAuth. Mirror the
    // session into our own Shop table (encrypted token) so the rest of the app
    // — which deals with two independent shops, not just "the" session shop —
    // has a single, consistent place to look up credentials for either side of
    // a StoreConnection.
    afterAuth: async ({ session }) => {
      await prisma.shop.upsert({
        where: { shopDomain: session.shop },
        create: {
          shopDomain: session.shop,
          accessTokenEncrypted: encryptToken(session.accessToken ?? ""),
          scope: session.scope ?? "",
          isActive: true,
        },
        update: {
          accessTokenEncrypted: encryptToken(session.accessToken ?? ""),
          scope: session.scope ?? "",
          isActive: true,
          uninstalledAt: null,
        },
      });

      await shopify.registerWebhooks({ session });
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
