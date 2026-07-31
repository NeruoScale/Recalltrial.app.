import type Stripe from "stripe";
import { storage } from "./storage";
import { sendGa4PurchaseEvent } from "./ga4";

export async function trackCheckoutSessionPurchase(session: Stripe.Checkout.Session): Promise<void> {
  try {
    if (session.mode !== "subscription") return;
    if (session.payment_status !== "paid") {
      console.log(`[purchase-tracking] Skipping session ${session.id}: payment_status=${session.payment_status}`);
      return;
    }

    const claimed = await storage.claimPurchaseEvent(session.id);
    if (!claimed) {
      console.log(`[purchase-tracking] Session ${session.id} already processed, skipping duplicate`);
      return;
    }

    const userId = session.metadata?.userId;
    if (!userId) {
      console.warn(`[purchase-tracking] Session ${session.id} has no metadata.userId, cannot attribute purchase`);
      return;
    }

    const value = (session.amount_total ?? 0) / 100;
    const currency = (session.currency ?? "usd").toUpperCase();

    let plan: string = "UNKNOWN";
    const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    if (subscriptionId) {
      const { resolvePurchasePlan } = await import("./stripeWebhookHandler");
      plan = await resolvePurchasePlan(subscriptionId);
    }

    await storage.logEvent(userId, "purchase", { plan, amount: value, currency });
    await sendGa4PurchaseEvent({ transactionId: session.id, value, currency, plan, userId });
  } catch (err) {
    console.error("[purchase-tracking] Failed to process checkout session:", err);
  }
}
