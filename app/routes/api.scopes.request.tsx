import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  isRequestableScope,
  missingRequestedScopes,
} from "../lib/shopify/scopes";

// Never authenticate on GET — a full-page hit here (old button / broken
// redirect) must soft-bounce into the app, not show Shopify's 401 page.
export const loader = async () => redirect("/app/settings");

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, scopes } = await authenticate.admin(request);
  const form = await request.formData();

  const requested = Array.from(
    new Set(
      form
        .getAll("scopes")
        .map(String)
        .map((scope) => scope.trim())
        .filter(Boolean)
        .filter(isRequestableScope),
    ),
  );

  // Only ask Shopify for scopes this shop does not already have (write_*
  // already covers matching read_*). Avoids useless consent loops.
  const stillMissing = missingRequestedScopes(session.scope ?? "");
  const scopesToRequest =
    requested.length > 0
      ? requested.filter((scope) => stillMissing.includes(scope))
      : stillMissing;

  const returnTo = String(form.get("returnTo") || "/app/settings");

  if (scopesToRequest.length > 0) {
    // Throws an App Bridge redirect to Shopify's consent screen.
    await scopes.request(scopesToRequest);
  }

  const scopeDetails = await scopes.query();
  await db.shop.update({
    where: { shopDomain: session.shop },
    data: { scope: scopeDetails.granted.join(",") },
  });

  return redirect(returnTo.startsWith("/app") ? returnTo : "/app/settings");
};
