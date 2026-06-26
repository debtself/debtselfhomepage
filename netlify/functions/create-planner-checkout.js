const Stripe = require('stripe')

const stripe = Stripe(process.env.STRIPE_SECRET_KEY)

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': 'https://debtself.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' }
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: 'price_1TmLH0Fk2PrrZSW3SYDYC0rp', quantity: 1 }],
      customer_creation: 'always',
      allow_promotion_codes: true,
      success_url: 'https://debtself.com/planner?payment=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://debtself.com/planner',
    })

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url: session.url }),
    }
  } catch (err) {
    console.error('Stripe session creation failed:', err.message)
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Could not create checkout session' }),
    }
  }
}
