// Matches the application's ordinary email-address form; no DNS/network lookup.
const emailPattern = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function validAuthBody(body, mode) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'email')
    || !Object.hasOwn(body, 'password')) return false;
  const { email, password } = body;
  if (typeof email !== 'string' || email.length > 254 || email !== email.trim()
    || email.split('@')[0].length > 64 || !emailPattern.test(email)) return false;
  if (typeof password !== 'string' || password.length === 0) return false;
  const bytes = Buffer.byteLength(password, 'utf8');
  if (mode === 'signup') return password.length >= 8 && password.trim().length > 0 && bytes <= 72;
  // Existing bcrypt accounts may have short passwords or passwords that bcrypt
  // historically truncated at 72 bytes. Do not rewrite their verification rule.
  return bytes <= 4096;
}

module.exports = { validAuthBody };
