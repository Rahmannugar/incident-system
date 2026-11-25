/* @name InsertIncident */
INSERT INTO sql_proof.incidents (id, summary, details)
VALUES (:id!, :summary!, :details)
RETURNING id, summary, details, created_at;

/* @name GetIncident */
SELECT id, summary, details, created_at
FROM sql_proof.incidents
WHERE id = :id!;

/* @name InsertOutbox */
INSERT INTO sql_proof.outbox (event_id, incident_id)
VALUES (:eventId!, :incidentId!)
RETURNING event_id, incident_id;

/* @name GetOutbox */
SELECT event_id, incident_id
FROM sql_proof.outbox
WHERE incident_id = :incidentId!;
