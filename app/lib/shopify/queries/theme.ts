export const MAIN_THEME_QUERY = `#graphql
  query duplifyMainTheme($after: String) {
    themes(first: 1, roles: [MAIN]) {
      edges {
        node {
          id
          name
          files(first: 250, after: $after) {
            edges {
              node {
                filename
                body {
                  ... on OnlineStoreThemeFileBodyText { content }
                  ... on OnlineStoreThemeFileBodyBase64 { contentBase64 }
                  ... on OnlineStoreThemeFileBodyUrl { url }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
`;

// Used both to list the destination's themes (finding a same-named target to
// upsert files onto) and, on the source side, to let the merchant pick a
// specific theme instead of always exporting the live/MAIN one.
export const THEMES_BY_NAME_QUERY = `#graphql
  query duplifyThemesByName {
    themes(first: 50) {
      edges { node { id name role } }
    }
  }
`;

// Generic node(id:) lookup rather than a dedicated `theme(id:)` root field —
// works for any specific theme the merchant picked in the New Migration form,
// not just the MAIN one.
export const THEME_FILES_BY_ID_QUERY = `#graphql
  query duplifyThemeFilesById($id: ID!, $after: String) {
    node(id: $id) {
      ... on OnlineStoreTheme {
        id
        name
        files(first: 250, after: $after) {
          edges {
            node {
              filename
              body {
                ... on OnlineStoreThemeFileBodyText { content }
                ... on OnlineStoreThemeFileBodyBase64 { contentBase64 }
                ... on OnlineStoreThemeFileBodyUrl { url }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;
