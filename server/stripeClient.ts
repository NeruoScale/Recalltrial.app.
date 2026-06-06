import Stripe from 'stripe';

async function getCredentials() {
  const secretKey = process.env.STRIPE_LIVE_SECRET_KEY;
  const publishableKey = process.env.STRIPE_LIVE_PUBLISHABLE_KEY;
  if (!secretKey || !publishableKey) {
    throw new Error('STRIPE_LIVE_SECRET_KEY and STRIPE_LIVE_PUBLISHABLE_KEY must be set');
  }
  return { secretKey, publishableKey };
}

export async function getUncachableStripeClient() {
  const { secretKey } = await getCredentials();
  return new Stripe(secretKey, {
    apiVersion: '2025-08-27.basil' as any,
  });
}

export async function getStripePublishableKey() {
  const { publishableKey } = await getCredentials();
  return publishableKey;
}

export async function getStripeSecretKey() {
  const { secretKey } = await getCredentials();
  return secretKey;
}

let stripeSync: any = null;

export async function getStripeSync() {
  if (!stripeSync) {
    const { StripeSync } = await import('stripe-replit-sync');
    const secretKey = await getStripeSecretKey();
    stripeSync = new StripeSync({
      poolConfig: {
        connectionString: process.env.DATABASE_URL!,
        max: 2,
      },
      stripeSecretKey: secretKey,
    });
  }
  return stripeSync;
}
