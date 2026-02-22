import { db } from "./db";
import { users } from "@shared/schema";
import { eq, sql } from "drizzle-orm";

const PRO_PRICE_IDS = () => [
  process.env.STRIPE_PRO_MONTHLY_PRICE_ID,
  process.env.STRIPE_PRO_YEARLY_PRICE_ID,
].filter(Boolean);

const PLUS_PRICE_IDS = () => [
  process.env.STRIPE_PLUS_MONTHLY_PRICE_ID,
  process.env.STRIPE_PLUS_YEARLY_PRICE_ID,
].filter(Boolean);

function determinePlanFromPriceId(priceId: string): "PLUS" | "PRO" {
  if (PRO_PRICE_IDS().includes(priceId)) return "PRO";
  return "PLUS";
}

async function determinePlanFromSubscriptionLocal(subscriptionId: string): Promise<"PLUS" | "PRO"> {
  try {
    const result = await db.execute(
      sql`SELECT si.price, p.product FROM stripe.subscription_items si
          JOIN stripe.prices p ON si.price = p.id
          WHERE si.subscription = ${subscriptionId}
          LIMIT 1`
    );
    const item = result.rows[0] as any;
    if (item) {
      if (PRO_PRICE_IDS().includes(item.price)) {
        return "PRO";
      }

      const prodResult = await db.execute(
        sql`SELECT metadata FROM stripe.products WHERE id = ${item.product} LIMIT 1`
      );
      const prod = prodResult.rows[0] as any;
      if (prod?.metadata) {
        const meta = typeof prod.metadata === 'string' ? JSON.parse(prod.metadata) : prod.metadata;
        if (meta.tier === 'pro') return "PRO";
      }
    }
  } catch (err) {
    console.error("Error determining plan from local subscription:", err);
  }
  return "PLUS";
}

async function determinePlanFromStripeAPI(subscriptionId: string): Promise<"PLUS" | "PRO"> {
  try {
    const { getUncachableStripeClient } = await import("./stripeClient");
    const stripe = await getUncachableStripeClient();
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
    const item = subscription.items.data[0];
    if (item?.price?.id) {
      return determinePlanFromPriceId(item.price.id);
    }
  } catch (err) {
    console.error("Error determining plan from Stripe API:", err);
  }
  return "PLUS";
}

const STATUS_MAP: Record<string, "ACTIVE" | "CANCELED" | "PAST_DUE" | "INCOMPLETE"> = {
  active: "ACTIVE",
  trialing: "ACTIVE",
  canceled: "CANCELED",
  past_due: "PAST_DUE",
  incomplete: "INCOMPLETE",
  incomplete_expired: "INCOMPLETE",
  unpaid: "PAST_DUE",
};

export async function syncUserSubscriptionFromStripe(stripeCustomerId: string): Promise<void> {
  try {
    const [user] = await db.select().from(users).where(eq(users.stripeCustomerId, stripeCustomerId)).limit(1);
    if (!user) {
      console.log(`No user found for Stripe customer ${stripeCustomerId}`);
      return;
    }

    let sub: any = null;

    const subResult = await db.execute(
      sql`SELECT id, status, current_period_end FROM stripe.subscriptions 
          WHERE customer = ${stripeCustomerId} 
          ORDER BY created DESC LIMIT 1`
    );
    sub = subResult.rows[0] || null;

    if (!sub) {
      try {
        const { getUncachableStripeClient } = await import("./stripeClient");
        const stripe = await getUncachableStripeClient();
        const subs = await stripe.subscriptions.list({ customer: stripeCustomerId, limit: 1 });
        if (subs.data.length > 0) {
          const apiSub = subs.data[0];
          sub = {
            id: apiSub.id,
            status: apiSub.status,
            current_period_end: (apiSub as any).current_period_end,
          };
          console.log(`Found subscription via Stripe API: ${apiSub.id} (status: ${apiSub.status})`);
        }
      } catch (apiErr) {
        console.error("Error fetching subscription from Stripe API:", apiErr);
      }
    }

    if (!sub) {
      await db.update(users).set({
        plan: "FREE",
        stripeSubscriptionId: null,
        subscriptionStatus: "CANCELED",
        currentPeriodEnd: null,
      }).where(eq(users.id, user.id));
      console.log(`User ${user.id} downgraded to FREE (no subscription found)`);
      return;
    }

    const isActive = sub.status === "active" || sub.status === "trialing";
    const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;

    let plan: "FREE" | "PLUS" | "PRO" = "FREE";
    if (isActive) {
      plan = await determinePlanFromSubscriptionLocal(sub.id);
      if (plan === "PLUS") {
        plan = await determinePlanFromStripeAPI(sub.id);
      }
    }

    await db.update(users).set({
      plan,
      stripeSubscriptionId: sub.id,
      subscriptionStatus: STATUS_MAP[sub.status] || "INCOMPLETE",
      currentPeriodEnd: periodEnd,
    }).where(eq(users.id, user.id));

    console.log(`User ${user.id} subscription synced: plan=${plan}, status=${sub.status}`);
  } catch (err) {
    console.error("Error syncing user subscription:", err);
  }
}

export async function syncUserSubscriptionByUserId(userId: string): Promise<void> {
  try {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user?.stripeCustomerId) return;
    await syncUserSubscriptionFromStripe(user.stripeCustomerId);
  } catch (err) {
    console.error("Error syncing user subscription by userId:", err);
  }
}
