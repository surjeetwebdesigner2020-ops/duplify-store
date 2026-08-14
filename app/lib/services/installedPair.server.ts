import db from "../../db.server";
import { isValidShopDomain, normalizeShopDomain } from "../shopify/shop-domain";

export type InstallPairResult =
  | { ok: true; pending: boolean; needsInstall?: boolean }
  | { ok: false; error: string; needsInstall?: boolean; installShopDomain?: string };

/**
 * Request a pair between two shops that already installed Duplify Store.
 * Does NOT silently mark READY — the other shop must Accept first
 * (mutual consent). Existing READY pairs stay READY on re-connect.
 */
export async function connectViaInstalledApp(params: {
  ownerShopId: string;
  /** Domain of the OTHER store (not the embedded one) */
  otherShopDomain: string;
  /** Is the embedded store the destination (import into here) or source (export from here)? */
  currentRole: "DESTINATION" | "SOURCE";
}): Promise<InstallPairResult> {
  const otherDomain = normalizeShopDomain(params.otherShopDomain);

  if (!isValidShopDomain(otherDomain)) {
    return {
      ok: false,
      error: "Enter a valid shop domain, e.g. your-store.myshopify.com",
    };
  }

  const ownerShop = await db.shop.findUnique({
    where: { id: params.ownerShopId },
  });
  if (!ownerShop) {
    return { ok: false, error: "Current shop is not fully registered yet" };
  }
  if (otherDomain === ownerShop.shopDomain) {
    return {
      ok: false,
      error: "Source and destination stores must be different shops",
    };
  }

  let otherShop = await db.shop.findUnique({
    where: { shopDomain: otherDomain },
  });

  const needsInstall =
    !otherShop ||
    !otherShop.isActive ||
    !otherShop.accessTokenEncrypted ||
    Boolean(otherShop.uninstalledAt);

  // Save the invitation before the second store installs. When that merchant
  // opens Duplify, afterAuth activates this placeholder and companion mode can
  // immediately show the pending approval request.
  if (!otherShop) {
    otherShop = await db.shop.create({
      data: {
        shopDomain: otherDomain,
        accessTokenEncrypted: "",
        scope: "",
        isActive: false,
      },
    });
  }

  const sourceShopId =
    params.currentRole === "DESTINATION" ? otherShop.id : ownerShop.id;
  const destinationShopId =
    params.currentRole === "DESTINATION" ? ownerShop.id : otherShop.id;

  const existing = await db.storeConnection.findUnique({
    where: {
      sourceShopId_destinationShopId: {
        sourceShopId,
        destinationShopId,
      },
    },
  });

  // Already approved pairs stay READY; new / archived / pending need consent.
  const nextStatus = existing?.status === "READY" ? "READY" : "PENDING";

  await db.storeConnection.upsert({
    where: {
      sourceShopId_destinationShopId: {
        sourceShopId,
        destinationShopId,
      },
    },
    create: {
      ownerShopId: ownerShop.id,
      sourceShopId,
      destinationShopId,
      status: "PENDING",
    },
    update: {
      status: nextStatus,
      // Initiator owns the pending request so the other shop can Accept.
      ownerShopId:
        nextStatus === "PENDING"
          ? ownerShop.id
          : (existing?.ownerShopId ?? ownerShop.id),
    },
  });

  return {
    ok: true,
    pending: nextStatus === "PENDING",
    ...(needsInstall ? { needsInstall: true } : {}),
  };
}

export async function acceptStoreConnection(params: {
  connectionId: string;
  actingShopId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const connection = await db.storeConnection.findUnique({
    where: { id: params.connectionId },
  });
  if (!connection || connection.status === "ARCHIVED") {
    return { ok: false, error: "Connection not found" };
  }
  if (connection.status === "READY") {
    return { ok: true };
  }
  if (connection.status !== "PENDING") {
    return { ok: false, error: "This connection cannot be accepted" };
  }

  const isParty =
    connection.sourceShopId === params.actingShopId ||
    connection.destinationShopId === params.actingShopId;
  if (!isParty) {
    return { ok: false, error: "You are not part of this store pair" };
  }
  // Initiator cannot self-approve.
  if (connection.ownerShopId === params.actingShopId) {
    return {
      ok: false,
      error: "Waiting for the other store to approve this connection",
    };
  }

  await db.storeConnection.update({
    where: { id: connection.id },
    data: { status: "READY" },
  });
  return { ok: true };
}

export async function declineStoreConnection(params: {
  connectionId: string;
  actingShopId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const connection = await db.storeConnection.findUnique({
    where: { id: params.connectionId },
  });
  if (!connection || connection.status === "ARCHIVED") {
    return { ok: false, error: "Connection not found" };
  }

  const isParty =
    connection.sourceShopId === params.actingShopId ||
    connection.destinationShopId === params.actingShopId ||
    connection.ownerShopId === params.actingShopId;
  if (!isParty) {
    return { ok: false, error: "You are not part of this store pair" };
  }

  await db.storeConnection.update({
    where: { id: connection.id },
    data: { status: "ARCHIVED" },
  });
  return { ok: true };
}
