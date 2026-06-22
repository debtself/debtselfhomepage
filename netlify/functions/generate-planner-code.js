const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const RESEND_API_KEY = process.env.RESEND_API_KEY

// Excludes 0, O, 1, I, L to avoid manual-entry ambiguity
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function generateSegment(len) {
  let s = ''
  for (let i = 0; i < len; i++) {
    s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  }
  return s
}

function generateCode() {
  return `DS-${generateSegment(4)}-${generateSegment(4)}`
}

function buildEmail(email, code) {
  return {
    from: 'debtself <support@debtself.com>',
    to: email,
    subject: 'Your debtself planner is ready',
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="margin:0;padding:0;background:#F7F5F0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
        <div style="max-width:520px;margin:0 auto;padding:32px 16px;">

          <div style="background:#FFFFFF;border-radius:16px;padding:32px;border:1px solid #E8E4DC;">
            <div style="background:#0A0E12;padding:16px 24px;border-radius:10px 10px 0 0;margin:-32px -32px 24px -32px;">
              <img src="https://debtself.com/assets/dark-wordmark.png" alt="debt/self" width="107" height="28" style="height:28px;width:107px;display:block;margin-bottom:8px;" />
            </div>

            <div style="font-size:11px;font-weight:700;color:#FF4D2E;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:12px;">Your access code</div>
            <div style="font-size:22px;font-weight:700;color:#0A0E12;margin-bottom:8px;">Your debtself planner is ready.</div>
            <div style="font-size:14px;color:#6B7280;line-height:1.6;margin-bottom:24px;">Use the code below to get started. Go to <a href="https://debtself.com/planner" style="color:#FF4D2E;text-decoration:none;">debtself.com/planner</a> and enter it when prompted.</div>

            <div style="background:#F7F5F0;border-radius:12px;padding:24px;margin:0 0 24px 0;text-align:center;">
              <div style="font-size:11px;font-weight:700;color:#6B7280;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:12px;">Your code</div>
              <div style="font-size:28px;font-weight:700;color:#0A0E12;letter-spacing:0.1em;font-family:'Courier New',Courier,monospace;">${code}</div>
            </div>

            <div style="font-size:12px;color:#6B7280;margin-top:24px;padding-top:16px;border-top:1px solid #E8E4DC;">
              Questions? Reply to this email or reach us at support@debtself.com
            </div>
          </div>

          <div style="text-align:center;margin-top:24px;font-size:11px;color:#6B7280;">
            Results vary. debtself is not a law firm and does not provide legal advice.
          </div>
        </div>
      </body>
      </html>
    `
  }
}

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
