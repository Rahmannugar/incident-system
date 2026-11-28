import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {object} from './integration.ts';

export type AlertKind = 'service_errors' | 'outbox_stalled';
export type AlertState = 'firing' | 'normal';
const definitions = {
  service_errors: {uid: 'incident-system-service-errors', threshold: 20},
  outbox_stalled: {uid: 'incident-system-outbox-stalled', threshold: 60},
} satisfies Record<AlertKind, {uid: string; threshold: number}>;
const observedFiring = new Map<string, number>();

async function grafana(path: string): Promise<unknown> {
  const password = process.env.INCIDENT_SYSTEM_GRAFANA_ADMIN_PASSWORD;
  assert.ok(password, 'Grafana administrator password must be configured');
  const response = await fetch(`http://127.0.0.1:13000${path}`, {
    headers: {Accept: 'application/json', Authorization: `Basic ${Buffer.from('admin:'+password).toString('base64')}`},
    redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, 'Grafana alert read API must succeed');
  const text = await response.text();
  assert.ok(Buffer.byteLength(text) <= 1024*1024, 'Grafana alert response exceeded the verification bound');
  return JSON.parse(text) as unknown;
}

async function runtimeRules() {
  // Grafana's Prometheus-compatible read API reports actual scheduler evaluations
  // and per-instance state. Provisioning/configuration alone cannot prove firing.
  const response = object(await grafana('/api/prometheus/grafana/api/v1/rules'));
  assert.equal(response.status, 'success');
  const groups = object(response.data).groups;
  assert.ok(Array.isArray(groups), 'Grafana must return rule groups');
  return groups.map(object).flatMap(group => {
    assert.ok(Array.isArray(group.rules));
    return group.rules.map(value => ({group, rule: object(value)}));
  });
}

export async function verifyAlertConfiguration() {
  const runtime = await runtimeRules();
  for (const definition of Object.values(definitions)) {
    const match = runtime.find(({rule}) => rule.uid === definition.uid);
    assert.ok(match, `Provisioned alert ${definition.uid} is missing`);
    assert.equal(match.group.name, 'operational-evidence');
    assert.equal(match.group.interval, 10);
    assert.equal(match.rule.isPaused, false);
    assert.equal(match.rule.duration, 30);
    // Export remains a supported file-provisioning endpoint in Grafana13. It
    // exposes the applied model without changing provenance or creating rules.
    const exported = object(await grafana(`/api/v1/provisioning/alert-rules/${definition.uid}/export?format=json`));
    assert.ok(Array.isArray(exported.groups));
    const groups = exported.groups.map(object);
    const group = groups.find(row => row.name === 'operational-evidence');
    assert.ok(group); assert.equal(match.group.file, 'Incident System');
    assert.ok(Array.isArray(group.rules));
    const rule = group.rules.map(object).find(row => row.uid === definition.uid);
    assert.ok(rule); assert.equal(rule.for, '30s');
    assert.equal(rule.noDataState, 'OK'); assert.equal(rule.execErrState, 'Error');
    assert.equal(rule.condition, 'B');
    const notification = object(rule.notification_settings ?? rule.notificationSettings);
    assert.equal(notification.receiver, 'empty', 'Local verification must use the empty receiver');
    assert.deepEqual(notification.mute_time_intervals, ['incident-system-local-no-notifications']);
    const annotations = object(rule.annotations);
    assert.ok(typeof annotations.summary === 'string' && annotations.summary.length > 10);
    assert.ok(typeof annotations.description === 'string' && annotations.description.length > 10);
    assert.ok(Array.isArray(rule.data));
    const queries = rule.data.map(object);
    const input = queries.find(query => query.refId === 'A');
    const condition = queries.find(query => query.refId === 'B');
    assert.ok(input && condition);
    assert.equal(input.datasourceUid, 'prometheus');
    const model = object(input.model);
    assert.equal(model.instant, true);
    assert.ok(typeof model.expr === 'string' && model.expr.includes('service_name') && model.expr.includes('source'));
    const threshold = object(condition.model);
    assert.equal(threshold.type, 'threshold'); assert.equal(threshold.expression, 'A');
    assert.ok(Array.isArray(threshold.conditions));
    const evaluator = object(object(threshold.conditions[0]).evaluator);
    assert.equal(evaluator.type, 'gt'); assert.deepEqual(evaluator.params, [definition.threshold]);
  }
  console.log(JSON.stringify({event: 'alerting.configuration_verified', rules: Object.keys(definitions).length}));
}

export interface AlertWaitOptions {
  source?: 'integration' | 'application';
  timeoutMs?: number;
  after?: Date;
  drive?: () => Promise<void>;
  recovered?: () => Promise<boolean>;
}
function state(value: unknown): string {
  const normalized = String(value).toLowerCase().split('(')[0]?.trim();
  if (normalized === 'alerting' || normalized === 'firing') return 'firing';
  if (normalized === 'normal' || normalized === 'inactive') return 'normal';
  return normalized ?? 'unknown';
}

export async function awaitAlertState(kind: AlertKind, expected: AlertState, service: string, options: AlertWaitOptions = {}) {
  assert.ok(['gateway','identity','order','inventory','payment','notification'].includes(service));
  const source = options.source ?? 'integration';
  const uid = definitions[kind].uid;
  const key = `${uid}:${service}:${source}`;
  const firingEvaluation = observedFiring.get(key);
  if (expected === 'normal') assert.ok(firingEvaluation, 'A resolving check must follow an observed firing instance');
  const deadline = Date.now() + (options.timeoutMs ?? 130000);
  const after = Math.max(options.after?.getTime() ?? 0, expected === 'normal' ? firingEvaluation ?? 0 : 0);
  let lastHealth = 'not_evaluated', lastStates: string[] = [];
  while (Date.now() < deadline) {
    await options.drive?.();
    const matches = await runtimeRules();
    const match = matches.find(({rule}) => rule.uid === uid);
    assert.ok(match, `Grafana stopped exposing alert ${uid}`);
    const {rule} = match;
    const evaluatedAt = typeof rule.lastEvaluation === 'string' ? Date.parse(rule.lastEvaluation) : NaN;
    lastHealth = String(rule.health);
    const alerts = rule.alerts === undefined ? [] : rule.alerts;
    assert.ok(Array.isArray(alerts));
    const instances = alerts.map(object).filter(alert => {
      const labels = object(alert.labels);
      return labels.service_name === service && labels.source === source;
    });
    lastStates = instances.map(alert => state(alert.state));
    const freshHealthy = rule.health === 'ok' && !rule.lastError && Number.isFinite(evaluatedAt) && evaluatedAt > after;
    const firing = freshHealthy && lastStates.includes('firing');
    const normal = freshHealthy && !lastStates.some(value => value !== 'normal') && (options.recovered ? await options.recovered() : true);
    if ((expected === 'firing' && firing) || (expected === 'normal' && normal)) {
      if (expected === 'firing') observedFiring.set(key, evaluatedAt);
      console.log(JSON.stringify({event: 'alerting.state_verified', rule_uid: uid, service, source, state: expected, evaluated_at: new Date(evaluatedAt).toISOString()}));
      return;
    }
    await delay(1000);
  }
  assert.fail(`Grafana ${kind} did not become ${expected} for ${service}/${source}; last health=${lastHealth}, instance states=${lastStates.join(',') || 'none'}`);
}
