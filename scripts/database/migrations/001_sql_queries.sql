-- This isolated schema proves tooling; it is not the Incident Service schema.
CREATE SCHEMA IF NOT EXISTS sql_proof;

CREATE TABLE IF NOT EXISTS sql_proof.incidents (
    id uuid PRIMARY KEY,
    summary text NOT NULL,
    details text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sql_proof.outbox (
    event_id uuid PRIMARY KEY,
    incident_id uuid NOT NULL REFERENCES sql_proof.incidents(id)
);

---- create above / drop below ----

DROP TABLE sql_proof.outbox;
DROP TABLE sql_proof.incidents;
DROP SCHEMA sql_proof;
