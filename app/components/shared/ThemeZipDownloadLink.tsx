import { useAppBridge } from "@shopify/app-bridge-react";

export function ThemeZipDownloadLink({ href, filename }: { href: string; filename: string }) {
  const shopify = useAppBridge();

  async function download() {
    const idToken = await (shopify as unknown as { idToken: () => Promise<string> }).idToken();
    const response = await fetch(href, { headers: { Authorization: `Bearer ${idToken}` } });
    if (!response.ok) throw new Error(`Theme ZIP download failed (${response.status})`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return <button type="button" onClick={download}>Download theme ZIP</button>;
}