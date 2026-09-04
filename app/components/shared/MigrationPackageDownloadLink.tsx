import { useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

export function MigrationPackageDownloadLink({ href, filename }: { href: string; filename: string }) {
  const shopify = useAppBridge();
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setIsDownloading(true);
    setError(null);
    try {
      const idToken = await (shopify as unknown as { idToken: () => Promise<string> }).idToken();
      const response = await fetch(href, { headers: { Authorization: `Bearer ${idToken}` } });
      if (!response.ok) throw new Error(`Package download failed (${response.status})`);
      if (!response.headers.get("content-type")?.includes("application/zip")) {
        throw new Error("The server returned an invalid package.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Package download failed.");
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <span>
      <button type="button" onClick={download} disabled={isDownloading}>
        {isDownloading ? "Preparing package..." : "Download full migration package"}
      </button>
      {error && <span role="alert"> {error}</span>}
    </span>
  );
}
