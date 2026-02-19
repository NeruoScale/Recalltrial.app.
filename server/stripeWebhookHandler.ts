import { db } from "./db";
import { users } from "@shared/schema";
import { eq, sql } from "drizzle-orm";

async function determinePlanFromSubscription(subscriptionId: string): Promise<"PRO" | "PREMIUM"> {
  try {
    const result = await db.execute(
      sql`SELECT si.price, p.product FROM stripe.subscription_items si
          JOIN stripe.prices p ON si.price = p.id
          WHERE si.subscription = ${subscriptionId}
          LIMIT 1`
    );
    const item = result.rows[0] as any;
    if (item) {
      const premiumPriceIds = [
        process.env.STRIPE_PREMIUM_MONTHLY_PRICE_ID,
        process.env.STRIPE_PREMIUM_YEARLY_PRICE_ID,
      ].filter(Boolean);
      if (premiumPriceIds.includes(item.price)) {
        return "PREMIUM";
      }

      const prodResult = await db.execute(
        sql`SELECT metadata FROM stripe.products WHERE id = ${item.product} LIMIT 1`
      );
      const prod = prodResult.rows[0] as any;
      if (prod?.metadata) {
        const meta = typeof prod.metadata === 'string' ? JSON.parse(prod.metadata) : prod.metadata;
        if (meta.tier === 'premium') return "PREMIUM";
      }
    }
  } catch (err) {
    console.error("Error determining plan from subscription:", err);
  }
  return "PRO";
}

export async function syncUserSubscriptionFromStripe(stripeCustomerId: string): Promise<void> {
  try {
    const [user] = await db.select().from(users).where(eq(users.stripeCustomerId, stripeCustomerId)).limit(1);
    if (!user) {
      console.log(`No user found for Stripe customer ${stripeCustomerId}`);
      return;
    }

    const subResult = await db.execute(
      sql`SELECT id, status, current_period_end FROM stripe.subscriptions 
          WHERE customer = ${stripeCustomerId} 
          ORDER BY created DESC LIMIT 1`
    );
    const sub = subResult.rows[0] as any;

    if (!sub) {
      await db.update(users).set({
        plan: "FREE",
        stripeSubscriptionId: null,
        subscriptionStatus: "CANCELED",
        currentPeriodEnd: null,
      }).where(eq(users.id, user.id));
      console.log(`User ${user.id} downgraded to FREE (no subscription)`);
      return;
    }

    const isActive = sub.status === "active" || sub.status === "trialing";
    const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;

    const statusMap: Record<string, "ACTIVE" | "CANCELED" | "PAST_DUE" | "INCOMPLETE"> = {
      active: "ACTIVE",
      trialing: "ACTIVE",
      canceled: "CANCELED",
      past_due: "PAST_DUE",
      incomplete: "INCOMPLETE",
      incomplete_expired: "INCOMPLETE",
      unpaid: "PAST_DUE",
    };

    let plan: "FREE" | "PRO" | "PREMIUM" = "FREE";
    if (isActive) {
      plan = await determinePlanFromSubscription(sub.id);
    }

    await db.update(users).set({
      plan,
      stripeSubscriptionId: sub.id,
      subscriptionStatus: statusMap[sub.status] || "INCOMPLETE",
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
