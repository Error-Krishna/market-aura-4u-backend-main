const router = require('express').Router();

const unavailable = (feature) => (req, res) => res.status(403).json({
  success: false,
  code: 'FEATURE_DISABLED',
  message: `${feature} is unavailable in this MVP.`,
});

// Mount before account lookup and provider handlers: these features are excluded
// from the MVP, including their legacy URLs and alternate HTTP methods.
router.use(['/publish', '/content/publish'], unavailable('Social publishing'));
router.use('/auth/instagram', unavailable('Social account connections'));
router.use(['/user/payment', '/payments'], unavailable('Payments and subscriptions'));

module.exports = router;
