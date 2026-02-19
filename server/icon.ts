export function extractDomain(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return urlStr.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  }
}

export async function getIconUrl(domain: string): Promise<string> {
  try {
    const html = await fetchPageHtml(`https://${domain}`);
    if (html) {
      const appleTouchIcon = extractMetaTag(html, /<link[^>]*rel=["']apple-touch-icon["'][^>]*href=["']([^"']+)["']/i);
      if (appleTouchIcon) return resolveUrl(appleTouchIcon, domain);

      const icon = extractMetaTag(html, /<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["']/i);
      if (icon) return resolveUrl(icon, domain);

      const iconAlt = extractMetaTag(html, /<link[^>]*href=["']([^"']+)["'][^>]*rel=["'](?:shortcut )?icon["']/i);
      if (iconAlt) return resolveUrl(iconAlt, domain);

      const ogImage = extractMetaTag(html, /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
      if (ogImage) return resolveUrl(ogImage, domain);
    }
  } catch {
  }

  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
}

function extractMetaTag(html: string, regex: RegExp): string | null {
  const match = html.match(regex);
  return match ? match[1] : null;
}

function resolveUrl(href: string, domain: string): string {
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return "https:" + href;
  if (href.startsWith("/")) return `https://${domain}${href}`;
  return `https://${domain}/${href}`;
}

async function fetchPageHtml(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "RecallTrial/1.0" },
      redirect: "follow",
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const text = await res.text();
    return text.substring(0, 50000);
  } catch {
    return null;
  }
}

export function guessServiceName(domain: string): string {
  const parts = domain.split(".");
  if (parts.length >= 2) {
    const name = parts[parts.length - 2];
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return domain;
}
