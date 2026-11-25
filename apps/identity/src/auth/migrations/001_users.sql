CREATE SCHEMA identity;

CREATE TABLE identity.users (
    id uuid PRIMARY KEY,
    email text NOT NULL CONSTRAINT users_email_unique UNIQUE,
    password_hash text NOT NULL,
    CONSTRAINT users_email_normalized CHECK (email = lower(email) AND octet_length(email) BETWEEN 3 AND 254)
);

CREATE TABLE identity.sessions (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
    user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);

---- create above / drop below ----

DROP TABLE identity.sessions;
DROP TABLE identity.users;
DROP SCHEMA identity;
