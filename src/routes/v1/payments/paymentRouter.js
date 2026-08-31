const express = require('express');
const paymentRouter = express.Router();
const verify = require('../../../utils/auth'); // Your Auth Middleware
const { createOrder, verifyPayment } = require('../../../controllers/payments/paymentControllers');

paymentRouter.post('/payment/create-order', verify, createOrder);
paymentRouter.post('/payment/verify', verify, verifyPayment);

module.exports = paymentRouter;