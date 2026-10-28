const GENERATION_FAILED = 'Generation failed';
const GENERATION_TIMEOUT = 'Content generation timed out. Please try again later.';

function generationFailure(error) {
  return error?.name === 'TimeoutError'
    ? { status: 504, code: 'GENERATION_TIMEOUT', message: GENERATION_TIMEOUT }
    : { status: 500, code: 'GENERATION_FAILED', message: GENERATION_FAILED };
}

function publicHistoryJob(job) {
  // Preserve Mongoose's id/Map serialization without changing saved documents.
  const serialized = typeof job.toJSON === 'function' ? job.toJSON() : job;
  // A plain record may retain a custom serializer; don't run it twice in res.json.
  const { toJSON: _toJSON, ...record } = serialized;
  if (Object.prototype.hasOwnProperty.call(record, 'error')) {
    record.error = record.error === GENERATION_TIMEOUT ? GENERATION_TIMEOUT : GENERATION_FAILED;
  }
  return record;
}

module.exports = { generationFailure, publicHistoryJob };
