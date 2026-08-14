export function isReservedDefinitionError(message: string): boolean {
  return /reserved for use by another application/i.test(message);
}

export function isAccessDeniedDefinitionError(message: string): boolean {
  return (
    /access denied for metafielddefinitioncreate/i.test(message) ||
    /access denied for metaobjectdefinitioncreate/i.test(message) ||
    /api client to have access to the namespace/i.test(message)
  );
}

export function isDefinitionInUseError(message: string): boolean {
  return (
    /already exists|key is in use|has already been taken/i.test(message) ||
    /in use for .+ metafields/i.test(message) ||
    /\btaken\b/i.test(message)
  );
}

export function isInvalidRemoteFileError(message: string): boolean {
  return /invalid .*url|url is invalid|source.*invalid/i.test(message);
}

/** App/Shopify-owned defs cannot be recreated by another app — don't enqueue. */
export function isAppOwnedMetafieldNamespace(namespace: string): boolean {
  const ns = namespace.trim().toLowerCase();
  return ns.startsWith("app--") || ns.startsWith("$app");
}

export function isAppOwnedMetaobjectType(type: string): boolean {
  const t = type.trim().toLowerCase();
  return t.startsWith("$app:") || t.startsWith("app--");
}

/** True reserved/denied/validation — leave as SKIPPED when we cannot map an existing dest def. */
export function shouldSkipDefinitionCreateError(message: string): boolean {
  return (
    isReservedDefinitionError(message) ||
    isAccessDeniedDefinitionError(message) ||
    /validations require that you select a metaobject/i.test(message)
  );
}

/** Errors where dest already has the definition (or we can look it up). */
export function shouldResolveExistingDefinition(message: string): boolean {
  return (
    isDefinitionInUseError(message) ||
    isReservedDefinitionError(message) ||
    isAccessDeniedDefinitionError(message)
  );
}

export function skippedDefinitionMessage(message: string): string {
  if (isReservedDefinitionError(message) || isAccessDeniedDefinitionError(message)) {
    return "Definition is owned/protected by Shopify or another app and cannot be recreated by Duplify";
  }
  if (/validations require that you select a metaobject/i.test(message)) {
    return "Definition needs a metaobject that is not available on the destination store";
  }
  return "Definition already exists on destination store";
}
