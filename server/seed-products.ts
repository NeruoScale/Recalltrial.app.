import { getUncachableStripeClient } from './stripeClient';

async function createProducts() {
  const stripe = await getUncachableStripeClient();

  const plusSearch = await stripe.products.search({ query: "metadata['tier']:'plus'" });
  let plusProduct = plusSearch.data[0];

  if (!plusProduct) {
    plusProduct = await stripe.products.create({
      name: 'RecallTrial Plus',
      description: 'Unlimited trials, calendar export, reminder customization.',
      metadata: { app: 'recalltrial', tier: 'plus' },
    });
    console.log('Created Plus product:', plusProduct.id);
  } else {
    console.log('Plus product exists:', plusProduct.id);
  }

  const plusPrices = await stripe.prices.list({ product: plusProduct.id, active: true });
  let plusMonthlyPrice = plusPrices.data.find(p => p.recurring?.interval === 'month' && p.unit_amount === 399);
  if (!plusMonthlyPrice) {
    plusMonthlyPrice = await stripe.prices.create({
      product: plusProduct.id,
      unit_amount: 399,
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: { plan: 'plus_monthly' },
    });
    console.log('Created Plus monthly price:', plusMonthlyPrice.id, '- $3.99/month');
  } else {
    console.log('Plus monthly price exists:', plusMonthlyPrice.id, `- $${plusMonthlyPrice.unit_amount! / 100}/month`);
  }

  let plusYearlyPrice = plusPrices.data.find(p => p.recurring?.interval === 'year' && p.unit_amount === 4070);
  if (!plusYearlyPrice) {
    plusYearlyPrice = await stripe.prices.create({
      product: plusProduct.id,
      unit_amount: 4070,
      currency: 'usd',
      recurring: { interval: 'year' },
      metadata: { plan: 'plus_yearly' },
    });
    console.log('Created Plus yearly price:', plusYearlyPrice.id, '- $40.70/year (15% off)');
  } else {
    console.log('Plus yearly price exists:', plusYearlyPrice.id, `- $${plusYearlyPrice.unit_amount! / 100}/year`);
  }

  const proSearch = await stripe.products.search({ query: "metadata['tier']:'pro'" });
  let proProduct = proSearch.data[0];

  if (!proProduct) {
    proProduct = await stripe.products.create({
      name: 'RecallTrial Pro',
      description: 'Everything in Plus, plus email scanning (coming soon).',
      metadata: { app: 'recalltrial', tier: 'pro' },
    });
    console.log('Created Pro product:', proProduct.id);
  } else {
    console.log('Pro product exists:', proProduct.id);
  }

  const proPrices = await stripe.prices.list({ product: proProduct.id, active: true });
  let proMonthlyPrice = proPrices.data.find(p => p.recurring?.interval === 'month' && p.unit_amount === 799);
  if (!proMonthlyPrice) {
    proMonthlyPrice = await stripe.prices.create({
      product: proProduct.id,
      unit_amount: 799,
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: { plan: 'pro_monthly' },
    });
    console.log('Created Pro monthly price:', proMonthlyPrice.id, '- $7.99/month');
  } else {
    console.log('Pro monthly price exists:', proMonthlyPrice.id, `- $${proMonthlyPrice.unit_amount! / 100}/month`);
  }

  let proYearlyPrice = proPrices.data.find(p => p.recurring?.interval === 'year' && p.unit_amount === 8150);
  if (!proYearlyPrice) {
    proYearlyPrice = await stripe.prices.create({
      product: proProduct.id,
      unit_amount: 8150,
      currency: 'usd',
      recurring: { interval: 'year' },
      metadata: { plan: 'pro_yearly' },
    });
    console.log('Created Pro yearly price:', proYearlyPrice.id, '- $81.50/year (15% off)');
  } else {
    console.log('Pro yearly price exists:', proYearlyPrice.id, `- $${proYearlyPrice.unit_amount! / 100}/year`);
  }

  console.log('\n=== Set these environment variables ===');
  console.log(`STRIPE_PLUS_MONTHLY_PRICE_ID=${plusMonthlyPrice.id}`);
  console.log(`STRIPE_PLUS_YEARLY_PRICE_ID=${plusYearlyPrice.id}`);
  console.log(`STRIPE_PRO_MONTHLY_PRICE_ID=${proMonthlyPrice.id}`);
  console.log(`STRIPE_PRO_YEARLY_PRICE_ID=${proYearlyPrice.id}`);
}

createProducts().catch(console.error);
