const MAX_TEXT_LENGTH = 5000;
const platforms = new Set(['twitter', 'linkedin', 'instagram', 'facebook', 'email', 'blog']);

function validGenerationBody(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === 1 && Object.hasOwn(body, 'prompt')
    && typeof body.prompt === 'string'
    && body.prompt.length <= MAX_TEXT_LENGTH && body.prompt.trim().length >= 5;
}

function validText(value, required = false) {
  if (value == null) return !required;
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH
    && (!required || value.trim().length > 0);
}

function validBrandProfile(bp) {
  if (!bp || typeof bp !== 'object' || Array.isArray(bp)) return false;
  const audience = bp.targetAudience;
  const audienceText = typeof audience === 'string' ? audience : audience?.description;
  if (![bp.companyName, bp.industry, bp.uvp, audienceText].every(value => validText(value, true))) {
    return false;
  }
  if (bp.brandVoice != null && (typeof bp.brandVoice !== 'object' || Array.isArray(bp.brandVoice))) {
    return false;
  }
  if (![bp.brandVoice?.tone, bp.brandVoice?.description,
    audience?.painPoint, audience?.desire].every(value => validText(value))) return false;
  if (bp.platforms == null) return true;
  return Array.isArray(bp.platforms) && bp.platforms.length <= platforms.size
    && new Set(bp.platforms).size === bp.platforms.length
    && bp.platforms.every(value => platforms.has(value));
}

module.exports = { validGenerationBody, validBrandProfile };
