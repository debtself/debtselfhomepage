const Stripe = require('stripe')
const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')
const { generateCode, buildEmail } = require('./utils/planner-email')

const stripe = Stripe(process.env.STRIPE_SECRET_KEY)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const RESEND_API_KEY = process.env.RESEND_API_KEY

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature']

  let stripeEvent
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message)
    return { statusCode: 400, body: `Webhook error: ${err.message}` }
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: JSON.stringify({ received: true }) }
  }

  try {
    const session = stripeEvent.data.object
    const stripeSessionId = session.id
    const email = (session.customer_details?.email || '').trim().toLowerCase()

    if (!email) {
      console.error('No customer email on session:', stripeSessionId)
      return { statusCode: 200, body: JSON.stringify({ received: true }) }
    }

    // Idempotency check — Stripe retries on non-2xx or timeouts
    const { data: existing } = await supabase
      .from('planner_codes')
      .select('code')
      .eq('stripe_session_id', stripeSessionId)
      .maybeSingle()

    if (existing) {
      return { statusCode: 200, body: JSON.stringify({ received: true }) }
    }

    const sessionToken = crypto.randomUUID()
    const now = new Date().toISOString()

    let code
    let inserted = false
    let lastInsertError = null

    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateCode()
      const { error: insertError } = await supabase
        .from('planner_codes')
        .insert({
          code: candidate,
          buyer_email: email,
          source: 'stripe',
          stripe_session_id: stripeSessionId,
          redeemed: true,
          redeemed_at: now,
          session_token: sessionToken,
          redemption_count: 1,
          created_at: now,
        })

      if (!insertError) {
        code = candidate
        inserted = true
        break
      }

      lastInsertError = insertError
      if (insertError.code !== '23505') {
        console.error('Insert error:', insertError.message)
        break
      }
    }

    if (!inserted) {
      console.error('Failed to insert planner code after retries:', lastInsertError?.message)
      return { statusCode: 200, body: JSON.stringify({ received: true }) }
    }

    try {
      const emailPayload = buildEmail(email, code)
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(emailPayload),
      })
      if (!res.ok) {
        const text = await res.text()
        console.error('Resend error:', text)
      }
    } catch (emailErr) {
      console.error('Email send error:', emailErr.message)
    }

  } catch (err) {
    console.error('Webhook handler error:', err.message)
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) }
}
