const Razorpay = require('razorpay');
const crypto = require('crypto');
const User = require('../../models/User');

// 1. Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const createOrder = async (req, res) => {
  try {
    const { amount, currency = "INR", planName } = req.body;
    const userId = req.user.id; // From your auth middleware

    console.log(`Creating order for ${planName} - Amount: ${amount}`);

    const options = {
      amount: amount * 100,
      currency: currency,
      receipt: `receipt_${Date.now()}`,
      notes: {
        userId: userId,
        plan: planName
      }
    };

    const order = await razorpay.orders.create(options);

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID // Send Key ID to frontend
    });

  } catch (error) {
    console.error("Razorpay Order Error:", error);
    res.status(500).json({ success: false, message: "Could not create order" });
  }
};

const verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, userId, planName } = req.body;

    // 1. Construct the signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;

    // 2. Generate expected signature
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    // 3. Compare
    const isAuthentic = expectedSignature === razorpay_signature;

    if (isAuthentic) {
      // ✅ Payment Success! Update Database
      console.log(`Payment Verified! Updating user ${userId} to plan ${planName}`);

      await User.findByIdAndUpdate(userId, {
        subscription: {
          status: 'active',
          plan: planName,
          startDate: new Date(),
          paymentId: razorpay_payment_id
        }
      });

      res.json({ success: true, message: "Payment verified successfully" });
    } else {
      res.status(400).json({ success: false, message: "Invalid Signature" });
    }

  } catch (error) {
    console.error("Verification Error:", error);
    res.status(500).json({ success: false, message: "Server Error during verification" });
  }
};

module.exports = { createOrder, verifyPayment };
