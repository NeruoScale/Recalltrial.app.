type DataLayerEvent = Record<string, unknown>;

declare global {
  interface Window {
    dataLayer: DataLayerEvent[];
  }
}

function pushToDataLayer(event: DataLayerEvent) {
  if (typeof window === "undefined") return;
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push(event);
}

export function trackPageView(path: string, title?: string) {
  pushToDataLayer({
    event: "page_view",
    page_path: path,
    page_location: window.location.href,
    page_title: title ?? document.title,
  });
}

export function trackEvent(eventName: string, params: Record<string, unknown> = {}) {
  pushToDataLayer({ event: eventName, ...params });
}
