const { performance } = require('node:perf_hooks');
const { validationDetails } = require('./generationValidationError');

const categories = Object.freeze({
  user_lookup: 'USER_LOOKUP_FAILED',
  job_create: 'JOB_CREATE_FAILED',
  prompt_preparation: 'PROMPT_PREPARATION_FAILED',
  provider_request: 'PROVIDER_TRANSPORT_ERROR',
  provider_http: 'PROVIDER_HTTP_ERROR',
  provider_body: 'PROVIDER_BODY_ERROR',
  output_empty: 'OUTPUT_EMPTY',
  output_truncated: 'OUTPUT_TRUNCATED',
  output_parse: 'OUTPUT_PARSE_ERROR',
  output_validation: 'OUTPUT_VALIDATION_ERROR',
  job_complete: 'JOB_COMPLETE_FAILED',
  job_failure_save: 'JOB_FAILURE_SAVE_FAILED',
});
const finishReasons = new Set(['stop', 'length', 'tool_calls', 'function_call', 'content_filter']);
const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

// Keep diagnostics separate from exceptions and public/persisted error responses.
// Every logged value is constructed here; never serialize provider/driver errors.
function createGenerationDiagnostics() {
  const started = performance.now();
  let stage = 'user_lookup';
  let httpStatus;
  let finishReason;
  const usage = {};
  return {
    enter(value) { stage = Object.hasOwn(categories, value) ? value : 'unknown'; },
    providerStatus(value) {
      httpStatus = Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
    },
    completion(data) {
      const reason = data?.choices?.[0]?.finish_reason;
      if (typeof reason === 'string') finishReason = finishReasons.has(reason) ? reason : 'other';
      for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
        const count = tokenCount(data?.usage?.[key]);
        if (count !== undefined) usage[key] = count;
      }
      const reasoning = tokenCount(data?.usage?.completion_tokens_details?.reasoning_tokens);
      if (reasoning !== undefined) usage.reasoning_tokens = reasoning;
    },
    failure(error, jobId) {
      const category = error?.name === 'TimeoutError' && ['provider_request', 'provider_body'].includes(stage)
        ? 'PROVIDER_TIMEOUT' : categories[stage] || 'GENERATION_UNKNOWN';
      const record = {
        event: 'generation_failure', stage, category,
        jobId: typeof jobId === 'string' && /^[a-f\d]{24}$/i.test(jobId) ? jobId : null,
        elapsedMs: Math.max(0, Math.round(performance.now() - started)),
      };
      if (httpStatus !== undefined) record.providerHttpStatus = httpStatus;
      if (finishReason !== undefined) record.finishReason = finishReason;
      if (Object.keys(usage).length) record.usage = { ...usage };
      if (stage === 'output_validation') Object.assign(record, validationDetails(error));
      return record;
    },
  };
}

module.exports = { createGenerationDiagnostics };
