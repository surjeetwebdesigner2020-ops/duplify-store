export const MENU_CREATE_MUTATION = `#graphql
  mutation duplifyMenuCreate($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
    menuCreate(title: $title, handle: $handle, items: $items) {
      menu { id handle }
      userErrors { field message }
    }
  }
`;

export const MENU_UPDATE_MUTATION = `#graphql
  mutation duplifyMenuUpdate($id: ID!, $title: String!, $handle: String, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
      menu { id handle }
      userErrors { field message }
    }
  }
`;

export interface MenuItemCreateInput {
  title: string;
  type: string;
  url?: string;
  resourceId?: string;
}
