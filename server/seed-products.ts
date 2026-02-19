import { getUncachableStripeClient } from './stripeClient';

async function createProducts() {
  const stripe = await getUncachableStripeClient();

  const proSearch = await stripe.products.search({ query: "metadata['tier']:'pro'" });
  let proProduct = proSearch.data[0];

  if (!proProduct) {
    proProduct = await stripe.products.create({
      name: 'RecallTrial Pro',
      description: 'Unlimited active trials with email reminders.',
      metadata: { app: 'recalltrial', tier: 'pro' },
    });
    console.log('Created Pro product:', proProduct.id);
  } else {
    console.log('Pro product exists:', proProduct.id);
  }

  const proPrices = await stripe.prices.list({ product: proProduct.id, active: true });
  let proMonthlyPrice = proPrices.data.find(p => p.recurring?.interval === 'month');
  if (!proMonthlyPrice) {
    proMonthlyPrice = await stripe.prices.create({
      product: proProduct.id,
      unit_amount: 499,
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: { plan: 'pro_monthly' },
    });
    console.log('Created Pro monthly price:', proMonthlyPrice.id, '- $4.99/month');
  } else {
    console.log('Pro monthly price exists:', proMonthlyPrice.id, `- $${proMonthlyPrice.unit_amount! / 100}/month`);
  }

  let proYearlyPrice = proPrices.data.find(p => p.recurring?.interval === 'year');
  if (!proYearlyPrice) {
    proYearlyPrice = await stripe.prices.create({
      product: proProduct.id,
      unit_amount: 4990,
      currency: 'usd',
      recurring: { interval: 'year' },
      metadata: { plan: 'pro_yearly' },
    });
    console.log('Created Pro yearly price:', proYearlyPrice.id, '- $49.90/year');
  } else {
    console.log('Pro yearly price exists:', proYearlyPrice.id, `- $${proYearlyPrice.unit_amount! / 100}/year`);
  }

  const premiumSearch = await stripe.products.search({ query: "metadata['tier']:'premium'" });
  let premiumProduct = premiumSearch.data[0];

  if (!premiumProduct) {
    premiumProduct = await stripe.products.create({
      name: 'RecallTrial Premium',
      description: 'Unlimited trials, priority reminders, and priority support.',
      metadata: { app: 'recalltrial', tier: 'premium' },
    });
    console.log('Created Premium product:', premiumProduct.id);
  } else {
    console.log('Premium product exists:', premiumProduct.id);
  }

  const premiumPrices = await stripe.prices.list({ product: premiumProduct.id, active: true });
  let premiumMonthlyPrice = premiumPrices.data.find(p => p.recurring?.interval === 'month');
  if (!premiumMonthlyPrice) {
    premiumMonthlyPrice = await stripe.prices.create({
      product: premiumProduct.id,
      unit_amount: 999,
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: { plan: 'premium_monthly' },
    });
    console.log('Created Premium monthly price:', premiumMonthlyPrice.id, '- $9.99/month');
  } else {
    console.log('Premium monthly price exists:', premiumMonthlyPrice.id, `- $${premiumMonthlyPrice.unit_amount! / 100}/month`);
  }

  let premiumYearlyPrice = premiumPrices.data.find(p => p.recurring?.interval === 'year');
  if (!premiumYearlyPrice) {
    premiumYearlyPrice = await stripe.prices.create({
      product: premiumProduct.id,
      unit_amount: 9990,
      currency: 'usd',
      recurring: { interval: 'year' },
      metadata: { plan: 'premium_yearly' },
    });
    console.log('Created Premium yearly price:', premiumYearlyPrice.id, '- $99.90/year');
  } else {
    console.log('Premium yearly price exists:', premiumYearlyPrice.id, `- $${premiumYearlyPrice.unit_amount! / 100}/year`);
  }

  console.log('\nEnvironment variables:');
  console.log(`STRIPE_PRO_MONTHLY_PRICE_ID=${proMonthlyPrice.id}`);
  console.log(`STRIPE_PRO_YEARLY_PRICE_ID=${proYearlyPrice.id}`);
  console.log(`STRIPE_PREMIUM_MONTHLY_PRICE_ID=${premiumMonthlyPrice.id}`);
  console.log(`STRIPE_PREMIUM_YEARLY_PRICE_ID=${premiumYearlyPrice.id}`);
}

createProducts().catch(console.error);
