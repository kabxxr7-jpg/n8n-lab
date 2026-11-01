// Deterministic rule-based fit score (0-100). Pure function, no I/O.
function scoreLeadRules(lead) {
  let score = 0;
  const reasons = [];
  const add = (points, why) => {
    score += points;
    reasons.push(`${why} (${points >= 0 ? '+' : ''}${points})`);
  };

  const e = lead.employees;
  if (e !== null && e !== undefined) {
    if (e >= 11 && e <= 200) add(25, 'company size 11-200');
    else if (e >= 201 && e <= 1000) add(20, 'company size 201-1000');
    else if (e > 1000) add(15, 'company size over 1000');
    else add(10, 'company size 1-10');
  }

  const title = String(lead.title || '');
  if (/\b(founder|owner|ceo|cto|coo|chief|head|vp|vice president|director)\b/i.test(title)) {
    add(25, 'senior title');
  } else if (/\b(manager|lead|principal)\b/i.test(title)) {
    add(10, 'manager-level title');
  }

  const budget = Number(lead.budget_usd || 0);
  if (budget >= 5000) add(30, 'budget at least 5000 USD');
  else if (budget >= 1000) add(15, 'budget at least 1000 USD');

  const message = String(lead.message || '').toLowerCase();
  const keywords = ['automation', 'n8n', 'workflow', 'integration', 'crm', 'api', 'webhook'];
  const found = keywords.filter((k) => message.includes(k));
  if (found.length) add(Math.min(found.length, 3) * 5, `mentions ${found.slice(0, 3).join(', ')}`);

  if (/@(gmail|yahoo|outlook|hotmail|proton|protonmail)\./i.test(String(lead.email || ''))) {
    add(-10, 'free-mail address');
  }

  score = Math.max(0, Math.min(100, score));
  const tier = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
  return { fit_score: score, tier, reasons };
}
