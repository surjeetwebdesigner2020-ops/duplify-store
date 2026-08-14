export const FILE_CREATE_MUTATION = `#graphql
  mutation duplifyFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        alt
        ... on GenericFile { url }
        ... on MediaImage { image { url } }
      }
      userErrors { field message }
    }
  }
`;

export interface FileCreateInput {
  originalSource: string;
  alt?: string;
  contentType: "IMAGE" | "VIDEO" | "FILE";
}
