# Payment API

Contracts: [payment_service.proto](../../packages/contracts/proto/incident/payment/v1/payment_service.proto).

## gRPC

Create one pending attempt for an owned pending order with a live reservation; retries return the stored attempt.
`/incident.payment.v1.PaymentService/InitiatePayment`

Read the payment attempt after checking order ownership through Order.
`/incident.payment.v1.PaymentService/GetPayment`

Check Payment database connectivity.
`/incident.payment.v1.PaymentService/CheckHealth`

## Provider webhook

Accept a timestamped HMAC-SHA256 signature over the raw JSON provider outcome; duplicate event IDs are idempotent and conflicting final outcomes cannot regress the attempt.
`POST /webhooks/provider`
