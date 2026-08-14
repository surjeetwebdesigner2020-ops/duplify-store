import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Duplicate Store</h1>
        <p className={styles.text}>
          Migrate products, variants, images and collections from one Shopify store to
          another — with a clear pre-migration scan, real-time progress, permanent ID
          mappings, and retry for anything that fails.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Connect two stores.</strong> Authorize a source and destination store,
            each via Shopify OAuth.
          </li>
          <li>
            <strong>Scan before you commit.</strong> See record counts, conflicts and
            required permissions before anything moves.
          </li>
          <li>
            <strong>Track and retry.</strong> Watch live progress and retry only what
            failed — nothing gets duplicated.
          </li>
        </ul>
      </div>
    </div>
  );
}
