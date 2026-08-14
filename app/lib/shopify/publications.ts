import type { AdminClient } from "./admin-client";
import { joinUserErrors } from "./graphql-safe";

const PUBLICATIONS_QUERY = `#graphql
  query duplifyPublications {
    publications(first: 25) {
      edges {
        node {
          id
          name
          catalog {
            title
          }
        }
      }
    }
  }
`;

const PUBLISHABLE_PUBLISH_MUTATION = `#graphql
  mutation duplifyPublishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

interface PublicationsResponse {
  publications: {
    edges: Array<{
      node: {
        id: string;
        name: string | null;
        catalog: { title: string | null } | null;
      };
    }>;
  };
}

interface PublishResponse {
  publishablePublish: {
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

const onlineStorePublicationCache = new Map<string, string | null>();

function looksLikeOnlineStore(node: {
  name: string | null;
  catalog: { title: string | null } | null;
}): boolean {
  const haystack = `${node.name ?? ""} ${node.catalog?.title ?? ""}`.toLowerCase();
  return (
    haystack.includes("online store") ||
    haystack.includes("online-store") ||
    haystack === "online store"
  );
}

export async function resolveOnlineStorePublicationId(
  admin: AdminClient,
): Promise<string | null> {
  const cached = onlineStorePublicationCache.get(admin.shopDomain);
  if (cached !== undefined) return cached;

  try {
    const result = await admin.graphql<PublicationsResponse>(
      PUBLICATIONS_QUERY,
      undefined,
      5,
    );
    const match =
      result.publications.edges.find((edge) => looksLikeOnlineStore(edge.node))
        ?.node.id ??
      result.publications.edges[0]?.node.id ??
      null;
    onlineStorePublicationCache.set(admin.shopDomain, match);
    return match;
  } catch {
    onlineStorePublicationCache.set(admin.shopDomain, null);
    return null;
  }
}

/**
 * Publish a product (or other publishable) to the destination Online Store
 * channel so migrated ACTIVE products are visible, not stuck at Channels = 0.
 */
export async function publishToOnlineStore(
  admin: AdminClient,
  resourceId: string,
): Promise<{ ok: boolean; message?: string }> {
  const publicationId = await resolveOnlineStorePublicationId(admin);
  if (!publicationId) {
    return {
      ok: false,
      message: "No Online Store publication found on destination",
    };
  }

  try {
    const result = await admin.graphql<PublishResponse>(
      PUBLISHABLE_PUBLISH_MUTATION,
      {
        id: resourceId,
        input: [{ publicationId }],
      },
      10,
    );
    const errors = result.publishablePublish?.userErrors;
    if ((errors?.length ?? 0) > 0) {
      return {
        ok: false,
        message: joinUserErrors(errors, "Unknown publishablePublish error"),
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
