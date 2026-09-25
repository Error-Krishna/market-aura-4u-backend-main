const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // --- Auth ---
  name: { type: String },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },

  // --- App Logic ---
  onboardingCompleted: { type: Boolean, default: false },
  isPremium: { type: Boolean, default: false },

  credits: {
    monthly: { type: Number, default: 100 },
    used: { type: Number, default: 0 }
  },

  // --- Brand Profile ---
  brandProfile: {
    companyName: { type: String, default: '' },
    industry: { type: String, default: '' },
    uvp: { type: String, default: '' },
    targetAudience: { type: String, default: '' },
    marketingGoal: { type: String, default: '' },

    brandVoice: {
      tone: { type: String, default: 'Professional' },
      description: { type: String, default: '' }
    },

    platforms: [{
      type: String,
      enum: ['twitter', 'linkedin', 'instagram', 'facebook', 'email', 'blog']
    }]
  },
  subscription: {
  status: { type: String, default: 'free' }, // free, active
  plan: { type: String, default: 'starter' },
  startDate: { type: Date },
  paymentId: { type: String }
},
  socialAccounts: {
    instagram: {
      instagramId: { type: String },
      accessToken: { type: String },
      isConnected: { type: Boolean, default: false }
    }
  }
}, { timestamps: true });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);