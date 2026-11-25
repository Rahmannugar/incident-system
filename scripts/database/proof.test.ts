import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createDatabasePool } from './database.ts';
import {
  getIncident,
  getOutbox,
  insertIncident,
  insertOutbox,
} from './incidents.queries.js';

const pool = createDatabasePool();

after(() => pool.end());

async function removeIncident(id: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM sql_proof.outbox WHERE incident_id = $1', [id]);
    await client.query('DELETE FROM sql_proof.incidents WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('generated INSERT RETURNING preserves nullable text and PostgreSQL timestamps', async () => {
  const id = randomUUID();
  try {
    const rows = await insertIncident.run({ id, summary: 'Payment timeout', details: null }, pool);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    assert.equal(row.id, id);
    assert.equal(row.summary, 'Payment timeout');
    assert.equal(row.details, null);
    assert.ok(row.created_at instanceof Date);
    assert.deepEqual(await getIncident.run({ id }, pool), rows);
  } finally {
    await removeIncident(id);
  }
});

test('one checked-out client commits incident and outbox together', async () => {
  const id = randomUUID();
  const eventId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertIncident.run({ id, summary: 'Inventory unavailable', details: 'Read-only investigation' }, client);
    await insertOutbox.run({ eventId, incidentId: id }, client);
    // A second connection must not see either uncommitted write.
    assert.deepEqual(await getIncident.run({ id }, pool), []);
    assert.deepEqual(await getOutbox.run({ incidentId: id }, pool), []);
    await client.query('COMMIT');
    const [incident] = await getIncident.run({ id }, pool);
    assert.ok(incident);
    assert.equal(incident.details, 'Read-only investigation');
    assert.deepEqual(await getOutbox.run({ incidentId: id }, pool), [{ event_id: eventId, incident_id: id }]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await removeIncident(id);
  }
});

test('an outbox constraint failure rolls back both writes', async () => {
  const id = randomUUID();
  const eventId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertIncident.run({ id, summary: 'Rollback proof', details: null }, client);
    await insertOutbox.run({ eventId, incidentId: id }, client);
    // Fail inside PostgreSQL rather than simulating a transaction error.
    await assert.rejects(insertOutbox.run({ eventId, incidentId: id }, client), { code: '23505' });
    await client.query('ROLLBACK');
    assert.deepEqual(await getIncident.run({ id }, pool), []);
    assert.deepEqual(await getOutbox.run({ incidentId: id }, pool), []);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await removeIncident(id);
  }
});
