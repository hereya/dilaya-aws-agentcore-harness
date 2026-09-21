// Package parameters arrive as environment variables, verbatim by name.

export interface Params {
  modelIds: string[];
  profilePrefix: string;
  logRetentionDays: number;
}

export const DEFAULT_MODEL_IDS = "anthropic.claude-haiku-4-5-20251001-v1:0";
export const DEFAULT_PROFILE_PREFIX = "eu";
export const DEFAULT_LOG_RETENTION_DAYS = 7;

/** CloudWatch Logs accepts only these retentions; anything else fails the API call. */
const ALLOWED_RETENTIONS = [1, 3, 5, 7, 14, 30, 60, 90];
const MODEL_ID_RE = /^[a-z0-9][a-z0-9.:-]{2,120}$/;
const PREFIX_RE = /^[a-z]{2,10}$/;

/** Throws on a value that would synth into a policy nobody intended — a typo in
 *  a model id would otherwise ship as a grant on a model that does not exist. */
export function readParams(env: Record<string, string | undefined>): Params {
  const modelIds = (env.modelIds || DEFAULT_MODEL_IDS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (modelIds.length === 0) throw new Error("modelIds: at least one model id is required");
  for (const id of modelIds) {
    if (!MODEL_ID_RE.test(id)) throw new Error(`modelIds: "${id}" is not a foundation-model id`);
    if (/^(eu|us|apac|global)\./.test(id)) {
      throw new Error(`modelIds: "${id}" carries an inference-profile prefix — pass the bare model id`);
    }
  }
  const profilePrefix = (env.inferenceProfilePrefix || DEFAULT_PROFILE_PREFIX).trim();
  if (!PREFIX_RE.test(profilePrefix)) throw new Error(`inferenceProfilePrefix: "${profilePrefix}" is not valid`);
  const logRetentionDays = Number(env.logRetentionDays || DEFAULT_LOG_RETENTION_DAYS);
  if (!ALLOWED_RETENTIONS.includes(logRetentionDays)) {
    throw new Error(`logRetentionDays: ${env.logRetentionDays} is not one of ${ALLOWED_RETENTIONS.join(", ")}`);
  }
  return { modelIds, profilePrefix, logRetentionDays };
}
