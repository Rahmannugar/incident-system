# Notification API

Verify a signed final-order event and persist its simulated email result. Duplicate deliveries reuse the stored result; temporary provider failure returns 503 for retry.
`POST /events/order`

Check whether the receiver is serving requests.
`GET /health/live`

Check Notification database connectivity.
`GET /health/ready`
