const mongoose = require('mongoose');
const Job = require('../../models/Job');
const { publicHistoryJob } = require('../../utils/generationFailure');

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 50;
const ALLOWED_QUERY_KEYS = new Set(['limit', 'cursor']);

function parseHistoryQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return null;
  if (Object.keys(query).some(key => !ALLOWED_QUERY_KEYS.has(key))) return null;

  let limit = DEFAULT_HISTORY_LIMIT;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^[1-9]\d*$/.test(query.limit)) return null;
    limit = Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit > MAX_HISTORY_LIMIT) return null;
  }

  let cursor = null;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string' || !/^[a-f\d]{24}$/i.test(query.cursor)) return null;
    if (!mongoose.Types.ObjectId.isValid(query.cursor)) return null;
    cursor = new mongoose.Types.ObjectId(query.cursor);
  }

  return { limit, cursor };
}

const getGeneratedContent = async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const pagination = parseHistoryQuery(req.query);
  if (!pagination) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_HISTORY_PAGINATION',
      message: 'History pagination parameters are invalid',
    });
  }

  try {
    const userId = req.user.id;
    const filter = { userId };

    if (pagination.cursor) {
      const cursorJob = await Job.findOne({ userId, _id: pagination.cursor }).select('createdAt');
      if (!cursorJob) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_HISTORY_PAGINATION',
          message: 'History pagination parameters are invalid',
        });
      }

      const cursorDate = cursorJob.createdAt;
      if (cursorDate instanceof Date && Number.isFinite(cursorDate.getTime())) {
        filter.$or = [
          { createdAt: { $lt: cursorDate } },
          { createdAt: cursorDate, _id: { $lt: pagination.cursor } },
          { createdAt: null },
        ];
      } else {
        filter.createdAt = null;
        filter._id = { $lt: pagination.cursor };
      }
    }

    const [fetched, total] = await Promise.all([
      Job.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(pagination.limit + 1),
      Job.countDocuments({ userId }),
    ]);

    const hasMore = fetched.length > pagination.limit;
    const jobs = hasMore ? fetched.slice(0, pagination.limit) : fetched;
    const lastJob = jobs[jobs.length - 1];

    return res.status(200).json({
      success: true,
      count: total,
      jobs: jobs.map(publicHistoryJob),
      pagination: {
        limit: pagination.limit,
        hasMore,
        nextCursor: hasMore && lastJob ? String(lastJob._id) : null,
      },
    });
  } catch {
    console.error('Error fetching history');
    return res.status(500).json({
      success: false,
      message: 'Server Error fetching content history',
    });
  }
};

module.exports = {
  getGeneratedContent,
  parseHistoryQuery,
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
};
