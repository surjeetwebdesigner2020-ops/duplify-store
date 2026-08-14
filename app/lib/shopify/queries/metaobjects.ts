export const METAOBJECT_DEFINITIONS_QUERY = `#graphql
  query duplifyMetaobjectDefinitions($after: String) {
    metaobjectDefinitions(first: 100, after: $after) {
      edges {
        node {
          id
          type
          name
          fieldDefinitions {
            key
            name
            required
            type { name }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Lookup an existing definition on destination by type. */
export const METAOBJECT_DEFINITION_BY_TYPE_QUERY = `#graphql
  query duplifyMetaobjectDefinitionByType($type: String!) {
    metaobjectDefinitionByType(type: $type) {
      id
      type
    }
  }
`;

export const METAOBJECTS_BY_TYPE_QUERY = `#graphql
  query duplifyMetaobjectsByType($type: String!, $after: String) {
    metaobjects(type: $type, first: 100, after: $after) {
      edges {
        node {
          id
          handle
          fields { key value type }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
