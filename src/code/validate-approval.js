// Validate the body of POST /lead-approve.
const body = $input.first().json.body;
const errors = [];
if (body === null || typeof body !== 'object' || Array.isArray(body)) {
  return [{ json: { valid: false, errors: ['body must be a JSON object'] } }];
}
const lead_id = typeof body.lead_id === 'string' ? body.lead_id.trim() : '';
const approved_by = typeof body.approved_by === 'string' ? body.approved_by.trim() : '';
if (!/^lead_[0-9]{1,12}$/.test(lead_id)) errors.push('lead_id must look like lead_123');
if (approved_by.length < 2 || approved_by.length > 80) errors.push('approved_by must be 2-80 characters');
if (errors.length) return [{ json: { valid: false, errors } }];
return [{ json: { valid: true, errors: [], lead_id, approved_by } }];
