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

Read an order owned by the authenticated caller.
`GET /orders/{id}`

## Health

Check whether the Gateway process is serving requests.
`GET /health/live`

Check whether Gateway can reach Identity, Order and their databases.
`GET /health/ready`
