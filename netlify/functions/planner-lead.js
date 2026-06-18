// netlify/functions/planner-lead.js
// POST { email, debt_amount, assessment }
// Upserts to planner_leads, fires Resend snapshot email

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const RESEND_API_KEY = process.env.RESEND_API_KEY

function fmt(n) {
  if (!n || isNaN(n)) return '$0'
  return '$' + Math.round(n).toLocaleString('en-US')
}

function buildEmail(email, debt_amount, assessment) {
  const hasAssessment = assessment && assessment.recommendedMethod

  const numberCard = hasAssessment ? `
    <div style="background:#F7F5F0;border-radius:12px;padding:24px;margin:24px 0;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #E8E4DC;">
        <span style="font-size:14px;color:#6B7280;">Total debt</span>
        <span style="font-size:16px;font-weight:700;color:#0A0E12;">${fmt(debt_amount)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #E8E4DC;">
        <span style="font-size:14px;color:#6B7280;">Recommended path</span>
        <span style="font-size:14px;font-weight:600;color:#0A0E12;">${assessment.recommendedMethod}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #E8E4DC;">
        <span style="font-size:14px;color:#6B7280;">Debt free by</span>
        <span style="font-size:14px;font-weight:600;color:#0A0E12;">${assessment.debtFreeDate || 'See your plan'}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:14px;color:#6B7280;">Interest saved vs minimums</span>
        <span style="font-size:16px;font-weight:700;color:#FF4D2E;">${fmt(assessment.interestSaved)}</span>
      </div>
    </div>
  ` : ''

  const settlementBlock = hasAssessment && assessment.settlementRelevant ? `
    <div style="background:#0A0E12;border-radius:12px;padding:24px;margin:24px 0;">
      <div style="font-size:11px;font-weight:700;color:#FF4D2E;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:8px;">If debt settlement is relevant for you</div>
      <div style="font-size:15px;font-weight:700;color:#FAF8F3;margin-bottom:8px;">Settlement companies charge ${fmt(debt_amount * 0.25)} to manage your balance.</div>
      <div style="font-size:13px;color:rgba(250,248,243,0.6);margin-bottom:16px;">debtself gives you the exact same process for $249 flat.</div>
      <a href="https://app.debtself.com" style="display:inline-block;background:#FF4D2E;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:700;">See how much you'd keep →</a>
    </div>
  ` : ''

  return {
    from: 'debtself <support@debtself.com>',
    to: email,
    subject: 'Your debt freedom plan is ready',
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="margin:0;padding:0;background:#F7F5F0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
        <div style="max-width:520px;margin:0 auto;padding:32px 16px;">

          <!-- Wordmark -->
          <div style="margin-bottom:32px;">
            <span style="font-size:20px;font-weight:700;color:#0A0E12;">debt</span><span style="font-size:20px;font-weight:700;color:#FF4D2E;">/</span><span style="font-size:20px;font-weight:700;color:#0A0E12;">self</span>
            <span style="font-size:16px;color:rgba(10,14,18,0.4);margin-left:6px;">planner</span>
          </div>

          <div style="background:#FFFFFF;border-radius:16px;padding:32px;border:1px solid #E8E4DC;">
            <div style="font-size:11px;font-weight:700;color:#FF4D2E;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:12px;">Your plan</div>
            <div style="font-size:22px;font-weight:700;color:#0A0E12;margin-bottom:8px;">Here's a copy of your debt freedom plan.</div>
            <div style="font-size:14px;color:#6B7280;line-height:1.6;margin-bottom:4px;">Go back to your plan anytime at debtself.com/planner.</div>

            ${numberCard}
            ${settlementBlock}

            <div style="font-size:12px;color:#6B7280;margin-top:24px;padding-top:16px;border-top:1px solid #E8E4DC;">
              Questions? Reply to this email or reach us at support@debtself.com
            </div>
          </div>

          <div style="text-align:center;margin-top:24px;font-size:11px;color:#6B7280;">
            debtself planner &nbsp;|&nbsp; debtself.com &nbsp;|&nbsp; Results are estimates. Not financial advice.
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

  let email, debt_amount, assessment
  try {
    const body = JSON.parse(event.body || '{}')
    email = (body.email || '').trim().toLowerCase()
    debt_amount = body.debt_amount || null
    assessment = body.assessment || null
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) }
  }

  if (!email || !email.includes('@')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid email required' }) }
  }

  // Upsert to planner_leads
  const { error: dbError } = await supabase
    .from('planner_leads')
    .upsert(
      { email, debt_amount, assessment, created_at: new Date().toISOString() },
      { onConflict: 'email', ignoreDuplicates: false }
    )

  if (dbError) {
    console.error('DB error:', dbError.message)
    // Don't fail the request over a DB error — still try to send email
  }

  // Send snapshot email
  try {
    const emailPayload = buildEmail(email, debt_amount, assessment)
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

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true }),
  }
}
