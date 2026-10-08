CREATE TABLE access_login_attempts (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX access_login_attempts_expiry ON access_login_attempts(expires_at);
