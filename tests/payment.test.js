// Hermetic test: intercept mongoose and razorpay before any require
const Module = require('module');
const origRequire = Module.prototype.require;

// --- Mock Mongoose ---
class MockSchema { constructor() {} }
MockSchema.Types = { ObjectId: String, Mixed: Object };
const mockMongoose = {
  Schema: MockSchema,
  model: (name) => {
    class MockModel {
      constructor(data) { Object.assign(this, data); }
      async save() { return this; }
      static async findById() { return null; }
      static async findByIdAndUpdate(id, update) { return { _id: id, ...update }; }
    }
    MockModel.modelName = name;
    return MockModel;
  },
  models: {},
};

// --- Mock Razorpay constructor ---
let lastRazorpayOptions = null;
let mockOrdersCreate = null; // set per-test
class MockRazorpay {
  constructor(options) {
    lastRazorpayOptions = options;
    this.orders = {
      create: (opts) => {
        if (mockOrdersCreate) return mockOrdersCreate(opts);
        throw new Error('mockOrdersCreate not set');
      }
    };
  }
}

Module.prototype.require = function (id) {
  if (id === 'mongoose') return mockMongoose;
  if (id === 'razorpay') return MockRazorpay;
  return origRequire.apply(this, arguments);
};

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// --- Helpers to build fake req/res ---
const makeRes = () => {
  const res = {};
  res.status = (code) => { res._status = code; return res; };
  res.json = (body) => { res._body = body; return res; };
  res._status = 200;
  res._body = null;
  return res;
};

describe('paymentController — lazy Razorpay initialization', () => {
  let createOrder, verifyPayment;
  let savedKeyId, savedKeySecret;

  beforeEach(() => {
    savedKeyId = process.env.RAZORPAY_KEY_ID;
    savedKeySecret = process.env.RAZORPAY_KEY_SECRET;
    lastRazorpayOptions = null;
    mockOrdersCreate = null;

    // Re-require fresh each time (clear module cache for paymentController only)
    const pcPath = require.resolve('../src/controllers/payments/paymentController');
    delete require.cache[pcPath];
    const pc = require('../src/controllers/payments/paymentController');
    createOrder = pc.createOrder;
    verifyPayment = pc.verifyPayment;
  });

  afterEach(() => {
    if (savedKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = savedKeyId;

    if (savedKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = savedKeySecret;
  });

  test('createOrder: missing RAZORPAY_KEY_ID returns 503', async () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;

    const req = { user: { id: 'user_1' }, body: { amount: 499, planName: 'Pro' } };
    const res = makeRes();
    await createOrder(req, res);

    assert.equal(res._status, 503);
    assert.equal(res._body.success, false);
    assert.ok(res._body.message.length > 0, 'should include a safe error message');
    assert.equal(lastRazorpayOptions, null, 'Razorpay constructor must NOT be called');
  });

  test('createOrder: missing RAZORPAY_KEY_SECRET returns 503', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
    delete process.env.RAZORPAY_KEY_SECRET;

    const req = { user: { id: 'user_1' }, body: { amount: 499, planName: 'Pro' } };
    const res = makeRes();
    await createOrder(req, res);

    assert.equal(res._status, 503);
    assert.equal(res._body.success, false);
    assert.equal(lastRazorpayOptions, null, 'Razorpay constructor must NOT be called');
  });

  test('createOrder: valid credentials — delegates to Razorpay and returns order', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';

    const fakeOrder = { id: 'order_abc123', amount: 49900, currency: 'INR' };
    mockOrdersCreate = async (opts) => {
      assert.equal(opts.amount, 49900);
      assert.equal(opts.currency, 'INR');
      return fakeOrder;
    };

    const req = { user: { id: 'user_2' }, body: { amount: 499, currency: 'INR', planName: 'Pro' } };
    const res = makeRes();
    await createOrder(req, res);

    assert.equal(res._status, 200, 'should succeed when credentials present');
    assert.equal(res._body.success, true);
    assert.equal(res._body.orderId, 'order_abc123');
    assert.ok(lastRazorpayOptions, 'Razorpay constructor SHOULD be called');
    assert.equal(lastRazorpayOptions.key_id, 'rzp_test_key');
  });

  test('verifyPayment: invalid signature returns 400 (no Razorpay instance needed)', async () => {
    delete process.env.RAZORPAY_KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = 'some_secret';

    const req = {
      user: { id: 'user_3' },
      body: {
        razorpay_order_id: 'order_x',
        razorpay_payment_id: 'pay_y',
        razorpay_signature: 'bad_signature',
        userId: 'user_3',
        planName: 'Basic'
      }
    };
    const res = makeRes();
    await verifyPayment(req, res);

    assert.equal(res._status, 400);
    assert.equal(res._body.success, false);
  });

  test('verifyPayment: valid HMAC signature returns 200', async () => {
    delete process.env.RAZORPAY_KEY_ID;
    const secret = 'valid_secret_for_verify';
    process.env.RAZORPAY_KEY_SECRET = secret;

    const order_id = 'order_test_001';
    const payment_id = 'pay_test_001';
    const body = `${order_id}|${payment_id}`;
    const validSignature = crypto.createHmac('sha256', secret).update(body).digest('hex');

    const req = {
      user: { id: 'user_4' },
      body: {
        razorpay_order_id: order_id,
        razorpay_payment_id: payment_id,
        razorpay_signature: validSignature,
        userId: 'user_4',
        planName: 'Pro'
      }
    };
    const res = makeRes();
    await verifyPayment(req, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
  });
});
