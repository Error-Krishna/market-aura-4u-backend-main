// controllers/contentController.js
const Job = require('../../models/job');

const getGeneratedContent = async (req, res) => {
  try {
    // 1. CHECK USER
    if (!req.user || !req.user.id) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // 2. FETCH JOBS
    // We only want 'completed' jobs because 'processing' ones have no content yet.
    // .sort({ createdAt: -1 }) puts the newest content at the top.
    const history = await Job.find({ 
      userId: req.user.id, 
      status: 'completed' 
    })
    .sort({ createdAt: -1 });

    // 3. RETURN DATA
    res.status(200).json({
      success: true,
      count: history.length,
      data: history
    });

  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server Error fetching content history' 
    });
  }
};

module.exports = {
  getGeneratedContent
};