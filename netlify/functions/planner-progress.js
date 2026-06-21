const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': 'https://debtself.com',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' }
  }

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  // Shared helper: validate session_token against planner_codes
  async function resolveSession(token) {
    const { data, error } = await supabase
      .from('planner_codes')
      .select('session_token')
      .eq('session_token', token)
      .eq('redeemed', true)
      .maybeSingle()
    if (error || !data) return false
    return true
  }

  if (event.httpMethod === 'GET') {
    const session_token = (event.queryStringParameters || {}).session_token
    if (!session_token) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'session_token is required' }) }
    }

    const valid = await resolveSession(session_token)
    if (!valid) {
      return { statusCode: 200, headers, body: JSON.stringify({ exists: false, error: 'Invalid session' }) }
    }

    const { data: progress, error: progressError } = await supabase
      .from('planner_progress')
      .select('debts, extra, method_locked, locked_method, months_completed, budget, credit_score, baseline_interest_saved, baseline_min_months, baseline_total_debt, updated_at')
      .eq('session_token', session_token)
      .maybeSingle()

    if (progressError) {
      return { statusCode: 500, headers, body: JSON.stringify({ exists: false, error: 'Could not load progress' }) }
    }

    if (!progress) {
      return { statusCode: 200, headers, body: JSON.stringify({ exists: false }) }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        exists: true,
        progress: {
          debts: progress.debts,
          extra: progress.extra,
          method_locked: progress.method_locked,
          locked_method: progress.locked_method,
          months_completed: progress.months_completed,
          budget: progress.budget,
          credit_score: progress.credit_score,
          baseline_interest_saved: progress.baseline_interest_saved,
          baseline_min_months: progress.baseline_min_months,
          baseline_total_debt: progress.baseline_total_debt,
          updated_at: progress.updated_at,
        },
      }),
    }
  }

  // POST
  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Invalid request' }) }
  }

  const { session_token, debts, extra, method_locked, locked_method, months_completed, budget, credit_score, baseline_interest_saved, baseline_min_months, baseline_total_debt } = body

  if (!session_token) {
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'session_token is required' }) }
  }

  if (!Array.isArray(debts)) {
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'debts must be an array' }) }
  }

  if (typeof budget !== 'object' || Array.isArray(budget) || budget === null) {
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'budget must be an object' }) }
  }

  const normalizedBudget = {
    income: typeof budget.income === 'number' ? budget.income : 0,
    expenses: typeof budget.expenses === 'number' ? budget.expenses : 0,
    obligations: typeof budget.obligations === 'number' ? budget.obligations : 0,
  }
  const normalizedCreditScore = (credit_score && typeof credit_score === 'string') ? credit_score : ''

  const valid = await resolveSession(session_token)
  if (!valid) {
    return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: 'Invalid session' }) }
  }

  // Fetch existing row before writing
  const { data: existing } = await supabase
    .from('planner_progress')
    .select('method_locked, locked_method, months_completed, baseline_interest_saved, baseline_min_months, baseline_total_debt')
    .eq('session_token', session_token)
    .maybeSingle()

  // Integrity rules
  const alreadyLocked = existing?.method_locked === true
  const savedMethodLocked = alreadyLocked ? true : !!method_locked
  const savedLockedMethod = alreadyLocked
    ? existing.locked_method
    : (['avalanche', 'snowball'].includes(locked_method) ? locked_method : null)
  const savedMonthsCompleted = Math.max(existing?.months_completed || 0, months_completed || 0)
  const savedBaselineInterestSaved = existing?.baseline_interest_saved != null
    ? existing.baseline_interest_saved
    : (baseline_interest_saved ?? null)
  const savedBaselineMinMonths = existing?.baseline_min_months != null
    ? existing.baseline_min_months
    : (baseline_min_months ?? null)
  const savedBaselineTotalDebt = existing?.baseline_total_debt != null
    ? existing.baseline_total_debt
    : (baseline_total_debt ?? null)

  const upsertPayload = {
    session_token,
    debts,
    extra: extra ?? 0,
    method_locked: savedMethodLocked,
    locked_method: savedLockedMethod,
    months_completed: savedMonthsCompleted,
    budget: normalizedBudget,
    credit_score: normalizedCreditScore,
    baseline_interest_saved: savedBaselineInterestSaved,
    baseline_min_months: savedBaselineMinMonths,
    baseline_total_debt: savedBaselineTotalDebt,
    updated_at: new Date().toISOString(),
  }

  const { data: savedRow, error: upsertError } = await supabase
    .from('planner_progress')
    .upsert(upsertPayload, { onConflict: 'session_token' })
    .select()
    .maybeSingle()

  if (upsertError) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Could not save progress' }) }
  }

  return { statusCode: 200, headers, body: JSON.stringify({ success: true, progress: savedRow }) }
}
