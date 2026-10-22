const { validBrandProfile } = require('./generationInput');

function parseOnboardingBody(body) {
  const textFields = ['companyName', 'industry', 'brandTone', 'uvp', 'targetAudience'];
  const fields = [...textFields, 'platforms'];
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.length
    || !fields.every(field => Object.hasOwn(body, field))) return null;
  if (!textFields.every(field => typeof body[field] === 'string'
    && body[field].length <= 5000 && body[field].trim().length > 0)) return null;
  if (!Array.isArray(body.platforms) || body.platforms.length === 0) return null;

  const profile = {
    companyName: body.companyName.trim(), industry: body.industry.trim(),
    uvp: body.uvp.trim(), targetAudience: body.targetAudience.trim(),
    brandVoice: { tone: body.brandTone.trim() }, platforms: [...body.platforms],
  };
  // Keep onboarding completion aligned with generation's supported context.
  return validBrandProfile(profile) ? profile : null;
}

module.exports = { parseOnboardingBody };
