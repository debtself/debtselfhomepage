const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': 'https://debtself.com',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' }
  }

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST' && event.httpMethod !== 'DELETE') {
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
      .select('debts, extra, method_locked, locked_method, months_completed, budget, credit_score, baseline_interest_saved, baseline_min_months, baseline_total_debt, baseline_min_total_interest, actual_interest_paid, updated_at')
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
          baseline_min_total_interest: progress.baseline_min_total_interest,
          actual_interest_paid: progress.actual_interest_paid,
          updated_at: progress.updated_at,
        },
      }),
    }
  }

  if (event.httpMethod === 'DELETE') {
    const session_token = (event.queryStringParameters || {}).session_token
    if (!session_token) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'session_token is required' }) }
    }

    const valid = await resolveSession(session_token)
    if (!valid) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: 'Invalid session' }) }
    }

    const { error: deleteError } = await supabase
      .from('planner_progress')
      .delete()
      .eq('session_token', session_token)

    if (deleteError) {
      console.error('planner_progress delete failed:', JSON.stringify({
        code: deleteError.code,
        message: deleteError.message,
        details: deleteError.details,
        hint: deleteError.hint,
      }))
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Could not reset progress' }) }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) }
  }

  // POST
  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Invalid request' }) }
  }

  const { session_token, debts, extra, method_locked, locked_method, months_completed, budget, credit_score, baseline_interest_saved, baseline_min_months, baseline_total_debt, baseline_min_total_interest, actual_interest_paid } = body

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
    .select('method_locked, locked_method, months_completed, debts, budget, credit_score, baseline_interest_saved, baseline_min_months, baseline_total_debt, baseline_min_total_interest, actual_interest_paid')
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
  const savedBaselineMinTotalInterest = existing?.baseline_min_total_interest != null
    ? existing.baseline_min_total_interest
    : (baseline_min_total_interest ?? null)
  const savedActualInterestPaid = Math.max(existing?.actual_interest_paid || 0, actual_interest_paid || 0)
  const savedBaselineTotalDebt = existing?.baseline_total_debt != null
    ? existing.baseline_total_debt
    : (baseline_total_debt ?? null)

  // Never overwrite real data with empty defaults from an early-step save.
  // An incoming budget of all zeros or an empty debts array indicates an early
  // save that hasn't reached that step yet — keep what's already stored.
  const incomingBudgetIsEmpty = !normalizedBudget.income && !normalizedBudget.expenses && !normalizedBudget.obligations
  const savedBudget = (incomingBudgetIsEmpty && existing?.budget) ? existing.budget : normalizedBudget

  const savedCreditScore = (normalizedCreditScore === '' && existing?.credit_score) ? existing.credit_score : normalizedCreditScore

  const incomingDebtsIsEmpty = !Array.isArray(debts) || debts.length === 0
  const savedDebts = (incomingDebtsIsEmpty && Array.isArray(existing?.debts) && existing.debts.length > 0) ? existing.debts : debts

  const upsertPayload = {
    session_token,
    debts: savedDebts,
    extra: extra ?? 0,
    method_locked: savedMethodLocked,
    locked_method: savedLockedMethod,
    months_completed: savedMonthsCompleted,
    budget: savedBudget,
    credit_score: savedCreditScore,
    baseline_interest_saved: savedBaselineInterestSaved,
    baseline_min_months: savedBaselineMinMonths,
    baseline_total_debt: savedBaselineTotalDebt,
    baseline_min_total_interest: savedBaselineMinTotalInterest,
    actual_interest_paid: savedActualInterestPaid,
    updated_at: new Date().toISOString(),
  }

  const { data: savedRow, error: upsertError } = await supabase
    .from('planner_progress')
    .upsert(upsertPayload, { onConflict: 'session_token' })
    .select()
    .maybeSingle()

  if (upsertError) {
    console.error('planner_progress upsert failed:', JSON.stringify({
      code: upsertError.code,
      message: upsertError.message,
      details: upsertError.details,
      hint: upsertError.hint,
    }))
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Could not save progress' }) }
  }

  return { statusCode: 200, headers, body: JSON.stringify({ success: true, progress: savedRow }) }
}
