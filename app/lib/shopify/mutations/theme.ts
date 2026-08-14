export const THEME_FILES_UPSERT_MUTATION = `#graphql
  mutation duplifyThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      upsertedThemeFiles { filename }
      userErrors { field message }
    }
  }
`;

export const THEME_CREATE_MUTATION = `#graphql
  mutation duplifyThemeCreate($name: String!, $source: URL!, $role: ThemeRole) {
    themeCreate(name: $name, source: $source, role: $role) {
      theme { id name role processing }
      userErrors { field message code }
    }
  }
`;

export const THEME_FILES_DELETE_MUTATION = `#graphql
  mutation duplifyThemeFilesDelete($themeId: ID!, $files: [String!]!) {
    themeFilesDelete(themeId: $themeId, files: $files) {
      deletedThemeFiles { filename }
      userErrors { field message }
    }
  }
`;

export const THEME_PROCESSING_QUERY = `#graphql
  query duplifyThemeProcessing($id: ID!) {
    theme(id: $id) {
      id
      processing
    }
  }
`;

export interface ThemeFileUpsertInput {
  filename: string;
  body: { type: "TEXT" | "BASE64" | "URL"; value: string };
}

/** Public Dawn zip used only as a create scaffold — source files overwrite it. */
export const THEME_CREATE_BASE_ZIP_URL =
  "https://github.com/Shopify/dawn/archive/refs/tags/v15.3.0.zip";
