const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  status: { 
    type: String, 
    enum: ['processing', 'completed', 'failed'], 
    default: 'processing' 
  },
  
  platforms: [String], // ['twitter', 'linkedin', 'email']
  originalContent: String, // User's input text
  generatedContent: {      // AI-generated content will go here
    type: Map,            // Flexible structure for different platforms
    of: mongoose.Schema.Types.Mixed
  },
  error: String
}, {
  timestamps: true // Adds createdAt, updatedAt automatically
});

module.exports = mongoose.model('Job', jobSchema);