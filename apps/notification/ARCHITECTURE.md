# Notification

Notification owns its PostgreSQL database and consumes version 1 final Order
events through QStash. It verifies the raw body and exact configured destination
using current/next signing keys before validating event data. It resumes optional
trace context only from that verified body. Local development
uses the official QStash container; SDK automatic dev-server startup is disabled.

`notifications.deliveries` is the durable inbox and simulated email result. Unique
event and order keys prevent duplicate or conflicting sends. A transaction locks
the receipt before invoking the in-process fake provider and stores the attempt,
status and stable simulated message reference together. No network email or SMTP
operation occurs. Duplicate delivery after commit returns the existing result.

Confirmed, failed and refunded orders have distinct templates. Missing contact
snapshots produce a stored `recipient_missing` failure without claiming a send.
`INCIDENT_SYSTEM_NOTIFICATION_PROVIDER_FAILURES` simulates zero, one or two
initial failures per event. Pending results return 503; retry resumes from the
stored attempt count. Three attempts bound provider processing. Terminal results
are acknowledged with 204, including recorded permanent failures.

The HTTP boundary limits bodies to 32 KiB, active deliveries to 16 and connections
to 64. Health routes do not process events. Logs contain event/order/correlation
IDs and static outcomes, not addresses, email bodies or credentials.
