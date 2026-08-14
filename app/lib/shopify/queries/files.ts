export const BULK_FILES_QUERY = `
{
  files {
    edges {
      node {
        id
        alt
        ... on GenericFile {
          url
        }
        ... on MediaImage {
          image { url }
        }
        ... on Video {
          sources { url }
        }
      }
    }
  }
}`;
