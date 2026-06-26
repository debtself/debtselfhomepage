const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': 'https://debtself.com',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' }
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  const sessionId = event.queryStringParameters?.session_id

  if (!sessionId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'session_id required' }) }
  }

  const { data, error } = await supabase
    .from('planner_codes')
    .select('session_token')
    .eq('stripe_session_id', sessionId)
    .maybeSingle()

  if (error) {
    console.error('Lookup error:', error.message)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lookup failed' }) }
  }

  if (data?.session_token) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ready: true, session_token: data.session_token }),
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ready: false }),
  }
}
