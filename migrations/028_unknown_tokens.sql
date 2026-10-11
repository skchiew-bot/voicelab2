-- A model call that failed or timed out may still have used tokens, but how many is not known. Record that as unknown
-- (NULL), never as a known zero (lesson L-005). Existing rows keep their counts.
ALTER TABLE ai_decisions ALTER COLUMN input_tokens DROP NOT NULL;
ALTER TABLE ai_decisions ALTER COLUMN output_tokens DROP NOT NULL;
