CREATE TABLE payments.refunds (
    payment_id uuid PRIMARY KEY REFERENCES payments.attempts(id),
    provider_reference text NOT NULL UNIQUE,
    completed_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

---- create above / drop below ----
DROP TABLE payments.refunds;
