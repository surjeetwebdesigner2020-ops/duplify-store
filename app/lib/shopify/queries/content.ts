export const BULK_PAGES_QUERY = `
{
  pages {
    edges {
      node {
        id
        title
        handle
        body
        isPublished
        templateSuffix
      }
    }
  }
}`;

export const PAGE_BY_HANDLE_QUERY = `#graphql
  query duplifyPageByHandle($query: String!) {
    pages(first: 1, query: $query) {
      edges { node { id handle } }
    }
  }
`;

export const BULK_BLOGS_QUERY = `
{
  blogs {
    edges {
      node {
        id
        title
        handle
        templateSuffix
        articles {
          edges {
            node {
              id
              title
              handle
              body
              summary
              tags
              isPublished
              image { url altText }
            }
          }
        }
      }
    }
  }
}`;

export const BLOG_BY_HANDLE_QUERY = `#graphql
  query duplifyBlogByHandle($query: String!) {
    blogs(first: 1, query: $query) {
      edges { node { id handle } }
    }
  }
`;
