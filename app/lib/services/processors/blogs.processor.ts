import db from "../../../db.server";
import { createAdminClient } from "../../shopify/admin-client";
import { collectGroupedBulkResults, runBulkQuery } from "../../shopify/bulk-operations";
import { BULK_BLOGS_QUERY, BLOG_BY_HANDLE_QUERY } from "../../shopify/queries/content";
import {
  ARTICLE_CREATE_MUTATION,
  BLOG_CREATE_MUTATION,
  BLOG_UPDATE_MUTATION,
  type ArticleCreateInput,
  type BlogCreateInput,
  type BlogUpdateInput,
} from "../../shopify/mutations/content";
import { getLiveMapping, saveMapping } from "../idMapping.service";
import { isMigrationCancelled, logEvent } from "../migrationJob.service";
import type { ArticleBulkPayload, BlogBulkPayload, ConflictStrategy } from "../types";
import { joinUserErrors } from "../../shopify/graphql-safe";
import type { MigrationJobWithConnection } from "../orchestrator.service";

interface BlogWithArticlesPayload {
  blog: BlogBulkPayload;
  articles: ArticleBulkPayload[];
}

export async function ensureBlogItems(job: MigrationJobWithConnection): Promise<void> {
  const existing = await db.migrationItem.count({ where: { migrationJobId: job.id, resourceType: "blog" } });
  if (existing > 0) return;

  await logEvent(job.id, "INFO", "Exporting blogs & articles from source store");
  const sourceAdmin = createAdminClient(job.storeConnection.sourceShop);
  const op = await runBulkQuery(sourceAdmin, BULK_BLOGS_QUERY);
  if (!op.url) {
    await logEvent(job.id, "INFO", "Source store has no blogs to migrate");
    return;
  }

  const grouped = await collectGroupedBulkResults(op.url);
  const validBlogs = grouped.filter((record) => {
    const parent = record.parent;
    return (
      typeof parent.id === "string" &&
      parent.id.startsWith("gid://shopify/Blog/") &&
      typeof parent.title === "string" &&
      typeof parent.handle === "string"
    );
  });
  const rows = validBlogs.map((record) => {
    const blog = record.parent as unknown as { id: string; title: string; handle: string; templateSuffix: string | null };
    const articles = (record.childrenByField.Article ?? []) as unknown as Array<{
      id: string;
      title: string;
      handle: string;
      body: string;
      summary: string | null;
      tags: string[];
      isPublished: boolean;
      image: { url: string; altText: string | null } | null;
    }>;

    const payload: BlogWithArticlesPayload = {
      blog: { id: blog.id, title: blog.title, handle: blog.handle, templateSuffix: blog.templateSuffix },
      articles: articles.map((a) => ({
        id: a.id,
        blogSourceId: blog.id,
        title: a.title,
        handle: a.handle,
        body: a.body,
        summary: a.summary,
        tags: a.tags,
        isPublished: a.isPublished,
        image: a.image,
      })),
    };

    return {
      migrationJobId: job.id,
      resourceType: "blog",
      stage: "blogs",
      sourceId: blog.id,
      status: "PENDING" as const,
      payload: payload as unknown as object,
    };
  });

  if (rows.length > 0) await db.migrationItem.createMany({ data: rows });
  await logEvent(job.id, "INFO", `Found ${rows.length} blogs to migrate`);
}

interface BlogCreateResponse {
  blogCreate: { blog: { id: string; handle: string } | null; userErrors: Array<{ field: string[]; message: string }> };
}
interface BlogUpdateResponse {
  blogUpdate: { blog: { id: string; handle: string } | null; userErrors: Array<{ field: string[]; message: string }> };
}
interface BlogByHandleResponse {
  blogs: { edges: Array<{ node: { id: string; handle: string } }> };
}
interface ArticleCreateResponse {
  articleCreate: { article: { id: string; handle: string } | null; userErrors: Array<{ field: string[]; message: string }> };
}

export async function runBlogsStage(job: MigrationJobWithConnection): Promise<void> {
  await ensureBlogItems(job);

  const conflictStrategy: ConflictStrategy =
    (job.conflictStrategy as Record<string, ConflictStrategy>).blogs ?? "SKIP";
  const destAdmin = createAdminClient(job.storeConnection.destinationShop);

  const pendingItems = await db.migrationItem.findMany({
    where: { migrationJobId: job.id, resourceType: "blog", status: { in: ["PENDING", "RETRYING"] } },
  });
  // Capture retry candidates before processing parent blogs so an article that
  // fails in this run is not retried again immediately.
  const failedArticles = await db.migrationItem.findMany({
    where: {
      migrationJobId: job.id,
      resourceType: "article",
      stage: "blogs",
      status: { in: ["FAILED", "RETRYING"] },
    },
  });

  for (const item of pendingItems) {
    if (await isMigrationCancelled(job.id)) return;
    const { blog, articles } = item.payload as unknown as BlogWithArticlesPayload;
    const storeConnectionId = job.storeConnectionId;

    await db.migrationItem.update({ where: { id: item.id }, data: { status: "PROCESSING", attempt: item.attempt + 1 } });

    let destinationBlogId =
      (await getLiveMapping(destAdmin, storeConnectionId, "blog", item.sourceId))?.destinationId ?? null;

    if (!destinationBlogId) {
      let existingId: string | null = null;
      try {
        const existing = await destAdmin.graphql<BlogByHandleResponse>(
          BLOG_BY_HANDLE_QUERY,
          { query: `handle:${JSON.stringify(blog.handle)}` },
          5,
        );
        existingId = existing.blogs.edges[0]?.node.id ?? null;
      } catch (error) {
        await fail(job.id, item.id, `Conflict check failed: ${errMsg(error)}`);
        await recordFailedArticles(job.id, articles, "Parent blog failed to create");
        continue;
      }

      if (existingId && conflictStrategy === "SKIP") {
        await db.migrationItem.update({
          where: { id: item.id },
          data: { status: "SKIPPED", errorMessage: "Blog with this handle already exists on the destination store" },
        });
        continue;
      }

      const input: BlogCreateInput = {
        title: blog.title,
        handle: existingId && conflictStrategy === "CREATE_NEW" ? `${blog.handle}-copy-${Date.now().toString(36)}` : blog.handle,
        templateSuffix: blog.templateSuffix ?? undefined,
      };

      try {
        const shouldUpdate = existingId !== null && conflictStrategy !== "CREATE_NEW";
        const outcome = shouldUpdate
          ? (
              await destAdmin.graphql<BlogUpdateResponse>(
              BLOG_UPDATE_MUTATION,
              { id: existingId!, blog: input satisfies BlogUpdateInput },
              10,
            )
            ).blogUpdate
          : (await destAdmin.graphql<BlogCreateResponse>(BLOG_CREATE_MUTATION, { blog: input }, 10)).blogCreate;
        if (outcome.userErrors.length > 0 || !outcome.blog) {
          const message = joinUserErrors(outcome.userErrors, `Unknown blog${shouldUpdate ? "Update" : "Create"} error`);
          await fail(job.id, item.id, message);
          await recordFailedArticles(job.id, articles, "Parent blog failed to create");
          continue;
        }
        destinationBlogId = outcome.blog.id;
        await saveMapping({ storeConnectionId, resourceType: "blog", sourceId: item.sourceId, destinationId: destinationBlogId });
      } catch (error) {
        await fail(job.id, item.id, errMsg(error));
        await recordFailedArticles(job.id, articles, "Parent blog failed to create");
        continue;
      }
    }

    await db.migrationItem.update({ where: { id: item.id }, data: { status: "COMPLETED", destinationId: destinationBlogId, errorMessage: null } });
    await logEvent(job.id, "INFO", `Migrated blog "${blog.title}"`, { sourceId: item.sourceId });

    for (const article of articles) {
      if (await isMigrationCancelled(job.id)) return;
      await processArticle(job, article, destinationBlogId, destAdmin);
    }
  }

  for (const item of failedArticles) {
    if (await isMigrationCancelled(job.id)) return;
    const article = item.payload as unknown as ArticleBulkPayload;
    const destinationBlogId = (
      await getLiveMapping(destAdmin, job.storeConnectionId, "blog", article.blogSourceId)
    )?.destinationId;
    if (destinationBlogId) {
      await processArticle(job, article, destinationBlogId, destAdmin, item);
    }
  }
}

async function processArticle(
  job: MigrationJobWithConnection,
  article: ArticleBulkPayload,
  destinationBlogId: string,
  destAdmin: ReturnType<typeof createAdminClient>,
  existingItem?: { id: string; attempt: number },
): Promise<void> {
  const storeConnectionId = job.storeConnectionId;
  const alreadyMapped = await getLiveMapping(destAdmin, storeConnectionId, "article", article.id);
  const item = existingItem ?? await db.migrationItem.findFirst({
    where: {
      migrationJobId: job.id,
      resourceType: "article",
      sourceId: article.id,
      status: { in: ["PENDING", "PROCESSING", "FAILED", "RETRYING"] },
    },
  });
  if (alreadyMapped) {
    if (item) {
      await db.migrationItem.update({
        where: { id: item.id },
        data: { status: "COMPLETED", destinationId: alreadyMapped.destinationId, errorMessage: null },
      });
    }
    return;
  }

  const migrationItem = item ?? await db.migrationItem.create({
    data: {
      migrationJobId: job.id,
      resourceType: "article",
      stage: "blogs",
      sourceId: article.id,
      status: "PROCESSING",
      attempt: 1,
      payload: article as unknown as object,
    },
  });
  if (item) {
    await db.migrationItem.update({
      where: { id: item.id },
      data: { status: "PROCESSING", attempt: item.attempt + 1, errorMessage: null },
    });
  }

  const input: ArticleCreateInput = {
    blogId: destinationBlogId,
    title: article.title,
    handle: article.handle,
    body: article.body,
    summary: article.summary ?? undefined,
    tags: article.tags,
    isPublished: article.isPublished,
  };

  try {
    const result = await destAdmin.graphql<ArticleCreateResponse>(ARTICLE_CREATE_MUTATION, { article: input }, 10);
    if (result.articleCreate.userErrors.length > 0 || !result.articleCreate.article) {
      const message = joinUserErrors(result.articleCreate?.userErrors, "Unknown articleCreate error");
      await db.migrationItem.update({ where: { id: migrationItem.id }, data: { status: "FAILED", errorMessage: message } });
      return;
    }
    const destinationId = result.articleCreate.article.id;
    await saveMapping({ storeConnectionId, resourceType: "article", sourceId: article.id, destinationId });
    await db.migrationItem.update({
      where: { id: migrationItem.id },
      data: { status: "COMPLETED", destinationId, errorMessage: null },
    });
  } catch (error) {
    await db.migrationItem.update({
      where: { id: migrationItem.id },
      data: { status: "FAILED", errorMessage: errMsg(error) },
    });
  }
}

async function recordFailedArticles(migrationJobId: string, articles: ArticleBulkPayload[], message: string): Promise<void> {
  for (const article of articles) {
    const existing = await db.migrationItem.findFirst({
      where: { migrationJobId, resourceType: "article", sourceId: article.id },
    });
    if (existing?.status === "COMPLETED" || existing?.status === "SKIPPED") continue;

    if (existing) {
      await db.migrationItem.update({
        where: { id: existing.id },
        data: { status: "FAILED", errorMessage: message },
      });
    } else {
      await db.migrationItem.create({
        data: {
          migrationJobId,
          resourceType: "article",
          stage: "blogs",
          sourceId: article.id,
          status: "FAILED",
          errorMessage: message,
          payload: article as unknown as object,
        },
      });
    }
  }
}

async function fail(migrationJobId: string, itemId: string, message: string): Promise<void> {
  await db.migrationItem.update({ where: { id: itemId }, data: { status: "FAILED", errorMessage: message } });
  await logEvent(migrationJobId, "ERROR", message, { itemId });
}
function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
