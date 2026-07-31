type Ga4PurchaseEventInput = {
  transactionId: string;
  value: number;
  currency: string;
  plan: string;
  userId?: string | null;
};

export async function sendGa4PurchaseEvent(input: Ga4PurchaseEventInput): Promise<void> {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_API_SECRET;

  if (!measurementId || !apiSecret) {
    console.log("[GA4] GA4_MEASUREMENT_ID/GA4_API_SECRET not set — skipping server-side purchase event");
    return;
  }

  // Measurement Protocol requires client_id; we don't have the browser's GA
  // client id at webhook time, so we use a stable per-user pseudo id.
  const clientId = input.userId ? `server.${input.userId}` : `server.${input.transactionId}`;

  const payload = {
    client_id: clientId,
    ...(input.userId ? { user_id: input.userId } : {}),
    events: [
      {
        name: "purchase",
        params: {
          transaction_id: input.transactionId,
          value: input.value,
          currency: input.currency.toUpperCase(),
          plan: input.plan,
          items: [
            {
              item_name: input.plan,
              item_category: "subscription",
              price: input.value,
              quantity: 1,
            },
          ],
        },
      },
    ],
  };

  try {
    const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[GA4] Purchase event rejected: HTTP ${res.status}`);
      return;
    }
    console.log(`[GA4] Purchase event sent for transaction ${input.transactionId}`);
  } catch (err) {
    console.error("[GA4] Failed to send purchase event:", err);
  }
}
