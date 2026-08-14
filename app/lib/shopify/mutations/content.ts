export const PAGE_CREATE_MUTATION = `#graphql
  mutation duplifyPageCreate($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page { id handle }
      userErrors { field message }
    }
  }
`;

export interface PageCreateInput {
  title: string;
  handle?: string;
  body?: string;
  isPublished?: boolean;
  templateSuffix?: string;
}

export const PAGE_UPDATE_MUTATION = `#graphql
  mutation duplifyPageUpdate($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) {
      page { id handle }
      userErrors { field message }
    }
  }
`;

export type PageUpdateInput = PageCreateInput;

export const BLOG_CREATE_MUTATION = `#graphql
  mutation duplifyBlogCreate($blog: BlogCreateInput!) {
    blogCreate(blog: $blog) {
      blog { id handle }
      userErrors { field message }
    }
  }
`;

export interface BlogCreateInput {
  title: string;
  handle?: string;
  templateSuffix?: string;
}

export const BLOG_UPDATE_MUTATION = `#graphql
  mutation duplifyBlogUpdate($blog: BlogUpdateInput!) {
    blogUpdate(blog: $blog) {
      blog { id handle }
      userErrors { field message }
    }
  }
`;

export interface BlogUpdateInput extends BlogCreateInput {
  id: string;
}

export const ARTICLE_CREATE_MUTATION = `#graphql
  mutation duplifyArticleCreate($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article { id handle }
      userErrors { field message }
    }
  }
`;

export interface ArticleCreateInput {
  blogId: string;
  title: string;
  handle?: string;
  body?: string;
  summary?: string;
  tags?: string[];
  isPublished?: boolean;
}
