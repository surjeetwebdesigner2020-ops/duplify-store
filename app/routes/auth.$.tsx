import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { redirect } = await authenticate.admin(request);

  return redirect("/app");
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
