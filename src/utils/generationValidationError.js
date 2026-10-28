// Only fixed reason/platform enums may reach diagnostics. Keep details private
// to locally created errors; never log provider data or arbitrary error fields.
const reasons = new Set([
  'INVALID_OUTPUT_OBJECT', 'MISSING_PLATFORM', 'INVALID_TWITTER_POSTS',
  'MISSING_TWITTER_TEXT', 'TWITTER_TEXT_TOO_LONG', 'INVALID_PLATFORM_POSTS',
  'INVALID_EMAIL', 'INVALID_INSTAGRAM_OBJECT', 'MISSING_INSTAGRAM_CAPTION',
  'INVALID_CAROUSEL_SLIDES', 'INVALID_CAROUSEL_SLIDE_TEXT',
]);
const platforms = new Set(['twitter', 'linkedin', 'facebook', 'blog', 'email', 'instagram']);
const details = new WeakMap();

class GenerationValidationError extends Error {
  constructor(message, reason, platform) {
    super(message);
    this.name = 'GenerationValidationError';
    details.set(this, {
      validationReason: reasons.has(reason) ? reason : 'UNKNOWN_VALIDATION_REASON',
      ...(platforms.has(platform) ? { validationPlatform: platform } : {}),
    });
  }
}

function validationDetails(error) {
  return details.get(error);
}

module.exports = { GenerationValidationError, validationDetails };
