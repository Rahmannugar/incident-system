# Incident System API

## Authentication

Create an account and return an opaque bearer session.
`POST /auth/signup`

Authenticate with email and password and return an opaque bearer session.
`POST /auth/login`

Read the current user and session expiry using an Authorization bearer token.
`GET /auth/me`

## Health

Check whether the Gateway process is serving requests.
`GET /health/live`

Check whether Gateway can reach Identity and its database.
`GET /health/ready`
