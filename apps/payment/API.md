# Payment API

Contracts: [payment_service.proto](../../packages/contracts/proto/incident/payment/v1/payment_service.proto).

## gRPC

Create one pending attempt for an owned pending order with a live reservation; retries return the stored attempt.
`/incident.payment.v1.PaymentService/InitiatePayment`

Read the payment attempt after checking order ownership through Order.
`/incident.payment.v1.PaymentService/GetPayment`

Read the canonical attempt and any completed refund using a Payment service credential.
`/incident.payment.v1.PaymentService/GetPaymentForSettlement`

Complete one simulated full refund for a successful payment; retries return the same completion. Requires the Payment service credential and matching payment/order IDs.
`/incident.payment.v1.PaymentService/RefundPayment`

Check Payment database connectivity.
`/incident.payment.v1.PaymentService/CheckHealth`

## Provider webhook

Accept a timestamped HMAC-SHA256 signature over the raw JSON provider outcome; duplicate event IDs are idempotent and conflicting final outcomes cannot regress the attempt.
`POST /webhooks/provider`
