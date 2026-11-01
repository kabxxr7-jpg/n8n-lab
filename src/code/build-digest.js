// Flatten every page of rows and build the digest text. Sends nothing itself.
const DIGEST_TO = 'leads-digest@n8n-lab.test';
const rows = $input.all().flatMap((item) => (Array.isArray(item.json.rows) ? item.json.rows : []));
const win = $('Compute window').first().json;

const by_status = {};
for (const r of rows) by_status[r.status] = (by_status[r.status] || 0) + 1;
const total = rows.length;
const pending = by_status.pending || 0;

const top = [...rows]
  .sort((a, b) => (b.fit_score || 0) - (a.fit_score || 0) || (a.id < b.id ? -1 : 1))
  .slice(0, 5);
const day = win.until.slice(0, 10);

const lines = [
  `Leads created in the last ${win.window_hours} hours: ${total}`,
  `By status: ${Object.entries(by_status).sort().map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
  `Awaiting approval: ${pending}`,
  '',
  'Top by fit score:',
  ...top.map((r) => `- ${r.id} | ${r.name} (${r.company}) | fit ${r.fit_score} ${r.tier} | ${r.status}`),
];

return [{
  json: {
    total, pending, by_status, to: DIGEST_TO,
    subject: `Lead digest ${day}: ${total} new, ${pending} awaiting approval`,
    body: lines.join('\n'),
  },
}];
