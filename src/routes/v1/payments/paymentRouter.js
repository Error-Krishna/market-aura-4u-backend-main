const express = require('express');
const paymentRouter = express.Router();
const verify = require('../../../middleware/auth'); // Your Auth Middleware
const { createOrder, verifyPayment } = require('../../../controllers/payments/paymentController');

paymentRouter.post('/payment/create-order', verify, createOrder);
paymentRouter.post('/payment/verify', verify, verifyPayment);

module.exports = paymentRouter;