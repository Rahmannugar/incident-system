# Identity gRPC API

Contracts: [identity_service.proto](../../packages/contracts/proto/incident/identity/v1/identity_service.proto).

Create a user and session atomically.
`/incident.identity.v1.IdentityService/SignUp`

Verify credentials and create a session.
`/incident.identity.v1.IdentityService/Login`

Revoke the supplied session token; repeating logout is safe.
`/incident.identity.v1.IdentityService/Logout`

Validate a session token and return its user and expiry.
`/incident.identity.v1.IdentityService/GetSession`

Check database availability.
`/incident.identity.v1.IdentityService/CheckHealth`
