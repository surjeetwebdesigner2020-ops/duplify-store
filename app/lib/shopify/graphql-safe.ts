/**
 * Shopify GraphQL payloads are not always the shape TypeScript claims.
 * Use these helpers so a missing/null field becomes a controlled failure
 * instead of `Cannot read properties of undefined` / `.some is not a function`.
 */

export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function connectionEdges<T>(connection: unknown): T[] {
  if (!connection || typeof connection !== "object") return [];
  const edges = (connection as { edges?: unknown }).edges;
  if (!Array.isArray(edges)) return [];
  const nodes: T[] = [];
  for (const edge of edges) {
    if (!edge || typeof edge !== "object") continue;
    const node = (edge as { node?: T }).node;
    if (node != null) nodes.push(node);
  }
  return nodes;
}

export function userErrorMessages(userErrors: unknown): string[] {
  return asArray<unknown>(userErrors)
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object") {
        const message = (entry as { message?: unknown }).message;
        return typeof message === "string" ? message : null;
      }
      return null;
    })
    .filter((message): message is string => Boolean(message));
}

export function joinUserErrors(
  userErrors: unknown,
  fallback = "Unknown Shopify mutation error",
): string {
  const messages = userErrorMessages(userErrors);
  return messages.length > 0 ? messages.join("; ") : fallback;
}

/**
 * Read a mutation payload that may be null when Shopify returns partial data.
 * Returns null when the root field is missing.
 */
export function mutationPayload<T extends Record<string, unknown>>(
  root: T | null | undefined,
): T | null {
  return root ?? null;
}
