const { createClient } = require('@supabase/supabase-js')
const { generateCode, buildEmail } = require('./utils/planner-email')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const RESEND_API_KEY = process.env.RESEND_API_KEY

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

  let secret, email, confirm
  try {
    const body = JSON.parse(event.body || '{}')
    secret = body.secret
    email = (body.email || '').trim().toLowerCase()
    confirm = !!body.confirm
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) }
  }

  if (secret !== process.env.ADMIN_DELIVERY_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) }
  }

  if (!email || !email.includes('@')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid email required' }) }
  }

  // Check for existing unredeemed code for this buyer
  const { data: existing, error: lookupError } = await supabase
    .from('planner_codes')
    .select('code')
    .eq('buyer_email', email)
    .eq('redeemed', false)
    .maybeSingle()

  if (lookupError) {
    console.error('Lookup error:', lookupError.message)
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Could not look up existing code' }) }
  }

  let code
  let reused = false

  if (existing && !confirm) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, code: existing.code, reused: true, needs_confirmation: true, email_sent: false }),
    }
  }

  if (existing) {
    code = existing.code
    reused = true
  } else {
    // Generate and insert a new code, retrying on uniqueness conflicts
    let inserted = false
    let lastInsertError = null
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateCode()
      const { error: insertError } = await supabase
        .from('planner_codes')
        .insert({
          code: candidate,
          buyer_email: email,
          redeemed: false,
          created_at: new Date().toISOString(),
        })

      if (!insertError) {
        code = candidate
        inserted = true
        break
      }

      lastInsertError = insertError

      // Only retry on uniqueness conflicts
      if (insertError.code !== '23505') {
        console.error('Insert error:', insertError.message)
        break
      }
    }

    if (!inserted) {
      console.error('Insert failed after retries:', lastInsertError && lastInsertError.message)
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Could not generate a unique code' }) }
    }
  }

  // Send access email
  let email_sent = false
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
    if (res.ok) {
      email_sent = true
    } else {
      const text = await res.text()
      console.error('Resend error:', text)
    }
  } catch (emailErr) {
    console.error('Email send error:', emailErr.message)
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true, code, reused, email_sent }),
  }
}
