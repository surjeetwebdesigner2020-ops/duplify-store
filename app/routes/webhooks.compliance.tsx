import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  recordCustomerDataRequest,
  redactCustomerData,
  redactShopData,
} from "../lib/services/privacyCompliance.server";

interface CustomerPrivacyPayload {
  customer?: {
    id?: number | string;
    email?: string | null;
  };
  orders_to_redact?: Array<number | string>;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      await recordCustomerDataRequest(shop, topic, payload);
      break;
    case "CUSTOMERS_REDACT":
      await redactCustomerData(shop, payload as CustomerPrivacyPayload);
      break;
    case "SHOP_REDACT":
      await redactShopData(shop);
      break;
    default:
      console.warn(`Unexpected compliance webhook topic ${topic} for ${shop}`);
  }

  return new Response(null, { status: 200 });
};
