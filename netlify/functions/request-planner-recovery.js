// netlify/functions/request-planner-recovery.js
// POST { email }
// Always returns the same generic response regardless of outcome.
const { createClient } = require('@supabase/supabase-js')
const { generateCode } = require('./utils/planner-email')

const RESEND_API_KEY = process.env.RESEND_API_KEY

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const GENERIC_RESPONSE = {
  success: true,
  message: 'If that email has a planner purchase, check your inbox for a recovery link.',
}

function buildRecoveryEmail(email, code) {
  const link = `https://debtself.com/planner?recovery_code=${code}`
  return {
    from: 'debtself <support@debtself.com>',
    to: email,
    subject: "Here's your way back into your debtself planner",
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
      <body style="margin:0;padding:0;background:#F7F5F0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
        <div style="max-width:520px;margin:0 auto;padding:32px 16px;">

          <div style="background:#FFFFFF;border-radius:16px;padding:32px;border:1px solid #E8E4DC;">
            <div style="margin:-32px -32px 24px -32px;">
              <img src="https://debtself.com/assets/dark-header-lockup.png" alt="debt/self" width="520" height="68" style="width:100%;height:auto;display:block;border-radius:10px 10px 0 0;" />
            </div>

            <div style="font-size:11px;font-weight:700;color:#FF4D2E;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:12px;">Planner recovery</div>
            <div style="font-size:22px;font-weight:700;color:#0A0E12;margin-bottom:8px;">Here's your way back in.</div>
            <div style="font-size:14px;color:#6B7280;line-height:1.6;margin-bottom:24px;">Click the button below to resume your planner right where you left off. This is a one-time recovery code — once used it can't be reused, so keep this email if you want a backup.</div>

            <div style="text-align:center;margin:0 0 24px 0;">
              <a href="${link}" style="display:inline-block;background:#FF4D2E;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:16px 32px;border-radius:10px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Resume my planner →</a>
            </div>

            <div style="background:#F7F5F0;border-radius:12px;padding:16px;margin:0 0 24px 0;text-align:center;">
              <div style="font-size:11px;font-weight:700;color:#6B7280;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:8px;">If the button doesn't work, enter this code manually at debtself.com/planner</div>
              <div style="font-size:20px;font-weight:700;color:#0A0E12;letter-spacing:0.1em;font-family:'Courier New',Courier,monospace;">${code}</div>
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
    `,
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

  let email
  try {
    const body = JSON.parse(event.body || '{}')
    email = (body.email || '').toString().trim().toLowerCase()
  } catch {
    return { statusCode: 200, headers, body: JSON.stringify(GENERIC_RESPONSE) }
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 200, headers, body: JSON.stringify(GENERIC_RESPONSE) }
  }

  try {
    // Check that email has at least one redeemed purchase
    const { data: purchase } = await supabase
      .from('planner_codes')
      .select('id')
      .eq('buyer_email', email)
      .eq('redeemed', true)
      .limit(1)
      .maybeSingle()

    if (!purchase) {
      return { statusCode: 200, headers, body: JSON.stringify(GENERIC_RESPONSE) }
    }

    // Rate limit: one recovery email per 10 minutes
    const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const { data: recentRecovery } = await supabase
      .from('planner_codes')
      .select('id')
      .eq('buyer_email', email)
      .eq('source', 'recovery')
      .gte('created_at', tenMinsAgo)
      .limit(1)
      .maybeSingle()

    if (recentRecovery) {
      return { statusCode: 200, headers, body: JSON.stringify(GENERIC_RESPONSE) }
    }

    // Generate and insert the recovery code (redeemed: false — normal unredeeemed code)
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
          source: 'recovery',
          redeemed: false,
          created_at: new Date().toISOString(),
        })

      if (!insertError) {
        code = candidate
        inserted = true
        break
      }

      lastInsertError = insertError
      if (insertError.code !== '23505') {
        console.error('Recovery code insert error:', insertError.message)
        break
      }
    }

    if (!inserted) {
      console.error('Failed to insert recovery code after retries:', lastInsertError?.message)
      return { statusCode: 200, headers, body: JSON.stringify(GENERIC_RESPONSE) }
    }

    try {
      const emailPayload = buildRecoveryEmail(email, code)
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
        console.error('Resend recovery email error:', text)
      }
    } catch (emailErr) {
      console.error('Recovery email send error:', emailErr.message)
    }

  } catch (err) {
    console.error('Request recovery handler error:', err.message)
  }

  return { statusCode: 200, headers, body: JSON.stringify(GENERIC_RESPONSE) }
}
