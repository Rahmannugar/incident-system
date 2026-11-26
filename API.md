# Incident System API

## Authentication

Create an account and return an opaque bearer session valid for seven days.
`POST /auth/signup`

Authenticate with email and password and return an opaque bearer session.
`POST /auth/login`

End the current session using an Authorization bearer token.
`POST /auth/logout`

Read the current user and session expiry using an Authorization bearer token.
`GET /auth/me`

## Orders

Create a pending single-item order using an Authorization bearer token.
`POST /orders`

Read an owned order and its pending, confirmed, failed or refunded state.
`GET /orders/{id}`

Reserve the stored item for an owned pending order; retries reuse the same reservation.
`POST /orders/{id}/reservation`

Read an owned order's reservation, including its expiry and state.
`GET /orders/{id}/reservation`

## Payments

Initiate payment for an owned reserved order; retries return its existing attempt.
`POST /orders/{id}/payment`

Read the owned order's payment status and quoted amount.
`GET /orders/{id}/payment`

Accept a signed QStash payment outcome and finalize its order after inventory or refund acknowledgement.
`POST /events/payment`

## Health

Check whether the Gateway process is serving requests.
`GET /health/live`

Check whether Gateway can reach Identity, Order, Inventory, Payment and their backing stores.
`GET /health/ready`
