// netlify/functions/validate-code.js
// POST { code: "DS-XXXX-XXXX" }
// Returns { valid: true, session_token: "uuid" } or { valid: false, error: "..." }

const { createClient } = require('@supabase/supabase-js')
const crypto = require('crypto')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

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

  let code
  try {
    const body = JSON.parse(event.body || '{}')
    code = (body.code || '').toString().trim().toUpperCase()
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ valid: false, error: 'Invalid request' }) }
  }

  if (!code) {
    return { statusCode: 400, headers, body: JSON.stringify({ valid: false, error: 'Code is required' }) }
  }

  // Basic format check
  if (!/^DS-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ valid: false, error: 'Code not recognized. Check your Etsy order confirmation.' })
    }
  }

  // Look up code
  const { data, error } = await supabase
    .from('planner_codes')
    .select('*')
    .eq('code', code)
    .single()

  if (error || !data) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ valid: false, error: 'Code not found. Check your Etsy order confirmation.' })
    }
  }

  if (!data.redeemed) {
    // First redemption — generate session token, mark redeemed
    const session_token = crypto.randomUUID()

    await supabase
      .from('planner_codes')
      .update({
        redeemed: true,
        redeemed_at: new Date().toISOString(),
        session_token,
        redemption_count: 1,
      })
      .eq('code', code)

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ valid: true, session_token })
    }
  }

  // Already redeemed — block access, increment redemption_count for observability
  await supabase
    .from('planner_codes')
    .update({ redemption_count: (data.redemption_count || 1) + 1 })
    .eq('code', code)

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ valid: false, error: 'This code has already been used. If you\'re the original buyer and lost access, contact support@debtself.com.' })
  }
}
