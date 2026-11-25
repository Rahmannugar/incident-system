/* @name InsertUser */
INSERT INTO identity.users (id, email, password_hash)
VALUES (:id!, :email!, :passwordHash!)
RETURNING id, email;

/* @name FindUserByEmail */
SELECT id, email, password_hash FROM identity.users WHERE email = :email!;

/* @name InsertSession */
INSERT INTO identity.sessions (token_hash, user_id, expires_at)
VALUES (:tokenHash!, :userId!, now() + (:ttlSeconds!::integer * interval '1 second'))
RETURNING expires_at;

/* @name FindSession */
SELECT u.id, u.email, s.expires_at
FROM identity.sessions s
JOIN identity.users u ON u.id = s.user_id
WHERE s.token_hash = :tokenHash! AND s.expires_at > now();

/* @name DeleteSession */
DELETE FROM identity.sessions WHERE token_hash = :tokenHash!;
