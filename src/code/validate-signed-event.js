// Validate the inbound event and the callback URL (allow-list: no SSRF to arbitrary hosts).
const ALLOWED_CALLBACK_PREFIX = 'http://127.0.0.1:4704/';
const body = $input.first().json.body;
const errors = [];

if (body === null || typeof body !== 'object' || Array.isArray(body)) {
  return [{ json: { valid: false, errors: ['body must be a JSON object'] } }];
}
const event_id = typeof body.event_id === 'string' ? body.event_id : '';
const text = typeof body.text === 'string' ? body.text.trim() : '';
const callback_url = typeof body.callback_url === 'string' ? body.callback_url : '';

if (!/^[A-Za-z0-9_-]{1,64}$/.test(event_id)) errors.push('event_id must be 1-64 characters of A-Z a-z 0-9 _ -');
if (text.length < 1 || text.length > 2000) errors.push('text must be 1-2000 characters');
if (!callback_url.startsWith(ALLOWED_CALLBACK_PREFIX) || callback_url.length > 300) {
  errors.push(`callback_url must start with ${ALLOWED_CALLBACK_PREFIX}`);
}
if (errors.length) return [{ json: { valid: false, errors } }];
return [{ json: { valid: true, errors: [], event: { event_id, text, callback_url } } }];
