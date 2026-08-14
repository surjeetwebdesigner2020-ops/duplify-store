// Stores only ever have a handful of menus, so a plain paginated query is
// simpler than a bulk operation here. `items` is a plain list field (not a
// connection), so nested item data comes back inline — sub-menu items
// (items[].items) are flattened to one level for Phase 1's implementation.
export const MENUS_QUERY = `#graphql
  query duplifyMenus($after: String) {
    menus(first: 50, after: $after) {
      edges {
        node {
          id
          handle
          title
          items {
            title
            type
            url
            resourceId
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const MENU_BY_HANDLE_QUERY = `#graphql
  query duplifyMenuByHandle($handle: String!) {
    menu(handle: $handle) { id handle }
  }
`;
