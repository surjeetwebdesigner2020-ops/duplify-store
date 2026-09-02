import { useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

type CsvDownloadLinkProps = {
  href: string;
  filename: string;
  slot?: string;
  children: React.ReactNode;
};

export function CsvDownloadLink({ href, filename, slot, children }: CsvDownloadLinkProps) {
  const shopify = useAppBridge();
  const [isDownloading, setIsDownloading] = useState(false);

  async function downloadReport() {
    setIsDownloading(true);
    try {
      const idToken = await (shopify as unknown as { idToken: () => Promise<string> }).idToken();
      const response = await fetch(href, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/csv")) throw new Error("The server returned an invalid report.");

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <button type="button" slot={slot} onClick={downloadReport} disabled={isDownloading}>
      {isDownloading ? "Downloading..." : children}
    </button>
  );
}