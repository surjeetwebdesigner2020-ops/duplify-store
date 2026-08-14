// Metafield definitions are scoped per owner type and aren't a single
// bulk-operation-friendly root connection (the field requires an ownerType
// argument), so these use regular paginated queries — definition counts are
// typically small (tens, not thousands) so pagination overhead is fine.
export const METAFIELD_DEFINITION_OWNER_TYPES = [
  "PRODUCT",
  "PRODUCTVARIANT",
  "COLLECTION",
  "CUSTOMER",
  "ORDER",
  "PAGE",
  "BLOG",
  "ARTICLE",
] as const;

export const METAFIELD_DEFINITIONS_QUERY = `#graphql
  query duplifyMetafieldDefinitions($ownerType: MetafieldOwnerType!, $after: String) {
    metafieldDefinitions(first: 100, after: $after, ownerType: $ownerType) {
      edges {
        node {
          id
          namespace
          key
          name
          description
          type { name }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Lookup a single definition on destination by ownerType + namespace + key. */
export const METAFIELD_DEFINITION_LOOKUP_QUERY = `#graphql
  query duplifyMetafieldDefinitionLookup(
    $ownerType: MetafieldOwnerType!
    $namespace: String!
    $key: String!
  ) {
    metafieldDefinitions(first: 1, ownerType: $ownerType, namespace: $namespace, key: $key) {
      edges {
        node { id namespace key }
      }
    }
  }
`;
