export const BULK_COLLECTIONS_QUERY = `
{
  collections {
    edges {
      node {
        id
        handle
        title
        descriptionHtml
        sortOrder
        templateSuffix
        image { url altText }
        ruleSet {
          appliedDisjunctively
          rules { column relation condition }
        }
      }
    }
  }
}`;

export const COLLECTION_BY_HANDLE_QUERY = `#graphql
  query duplifyCollectionByHandle($query: String!) {
    collections(first: 1, query: $query) {
      edges { node { id handle } }
    }
  }
`;
