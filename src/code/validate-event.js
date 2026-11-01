// Validate the inbound event for the retry/dedupe workflow.
const body = $input.first().json.body;
const errors = [];
if (body === null || typeof body !== 'object' || Array.isArray(body)) {
  return [{ json: { valid: false, errors: ['body must be a JSON object'] } }];
}
const event_id = typeof body.event_id === 'string' ? body.event_id : '';
const type = typeof body.type === 'string' ? body.type.trim() : '';
const data = body.data !== null && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : null;

if (!/^[A-Za-z0-9_-]{1,64}$/.test(event_id)) errors.push('event_id must be 1-64 characters of A-Z a-z 0-9 _ -');
if (type.length < 1 || type.length > 60) errors.push('type must be 1-60 characters');
if (data === null) errors.push('data must be a JSON object');
if (errors.length) return [{ json: { valid: false, errors } }];
return [{ json: { valid: true, errors: [], event_id, type, data } }];
