CREATE TABLE IF NOT EXISTS "api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" varchar(100) NOT NULL,
  "key_prefix" varchar(24) NOT NULL,
  "key_hash" varchar(64) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "last_used_at" timestamptz,
  "revoked_at" timestamptz,
  "expires_at" timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_api_keys_key_prefix" ON "api_keys" ("key_prefix");
CREATE INDEX IF NOT EXISTS "idx_api_keys_org_id" ON "api_keys" ("org_id");
