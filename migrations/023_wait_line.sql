-- The short line a reconnected caller hears while the call waits to carry on ("One moment, please."), so a caller is not
-- left in silence while the relay decides whether a dead server's start or reply will land. Null means the default line.
ALTER TABLE fallback_plans ADD COLUMN wait_message text CHECK (wait_message IS NULL OR length(wait_message) BETWEEN 1 AND 200);
