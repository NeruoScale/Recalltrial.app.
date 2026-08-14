type DataLayerEvent = Record<string, unknown>;

declare global {
  interface Window {
    dataLayer?: DataLayerEvent[];
  }
}

function pushToDataLayer(event: DataLayerEvent): void {
  try {
    if (typeof window === "undefined") return;
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(event);
  } catch (err) {
    // Never let analytics break the app — but surface the failure instead of swallowing it silently,
    // so a blocked/broken dataLayer is debuggable instead of invisible.
    console.error("[analytics] dataLayer.push failed:", err, event);
  }
}

export function trackPageView(path: string): void {
  pushToDataLayer({
    event: "page_view",
    page_path: path,
    page_location: typeof window !== "undefined" ? window.location.href : undefined,
    page_title: typeof document !== "undefined" ? document.title : undefined,
  });
}

export function trackSignUp(method: string = "email"): void {
  // TEMP: verify the sign_up push actually fires in GTM Preview. Remove once confirmed.
  console.log("[Analytics] sign_up fired", { method });
  pushToDataLayer({
    event: "sign_up",
    method,
  });
}

export function trackLogin(method: string = "email"): void {
  pushToDataLayer({
    event: "login",
    method,
  });
}

export function trackTrialCreated(serviceName: string, category?: string): void {
  pushToDataLayer({
    event: "trial_created",
    service_name: serviceName,
    ...(category ? { category } : {}),
  });
}

export function trackBeginCheckout(plan: string, value: number, currency: string): void {
  pushToDataLayer({
    event: "begin_checkout",
    currency: currency.toUpperCase(),
    value,
    items: [{ item_name: plan, item_category: "subscription", price: value }],
  });
}

export function trackPurchase(plan: string, value: number, currency: string): void {
  pushToDataLayer({
    event: "purchase",
    currency: currency.toUpperCase(),
    value,
    items: [{ item_name: plan, item_category: "subscription", price: value }],
  });
}
