ALTER TABLE payments.attempts ADD COLUMN traceparent text;

---- create above / drop below ----
ALTER TABLE payments.attempts DROP COLUMN traceparent;
