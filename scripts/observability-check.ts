import assert from 'node:assert/strict';
import {object} from './integration.ts';

async function json(url: string, headers: Record<string,string> = {}) {
  const response = await fetch(url,{headers:{Accept:'application/json',...headers},signal:AbortSignal.timeout(4000)});
  if(!response.ok)return undefined;
  return await response.json() as unknown;
}
function objects(value: unknown): Record<string,unknown>[] {
  if(Array.isArray(value))return value.flatMap(objects);
  if(value!==null && typeof value==='object'){const row=value as Record<string,unknown>;return [row,...Object.values(row).flatMap(objects)];}
  return [];
}
export async function verifyStoredEvidence(traceID:string,confirmedOrderID:string,secrets:string[]) {
  assert.match(traceID,/^[a-f0-9]{32}$/);
  let trace:unknown,logs:Record<string,unknown>[]=[];
  for(let attempt=0;attempt<60;attempt++){
    trace=await json(`http://127.0.0.1:13200/api/traces/${traceID}`);
    const query=`{service_name=~"gateway|identity|order|inventory|payment|notification"} | json | trace_id="${traceID}"`;
    const url=new URL('http://127.0.0.1:13100/loki/api/v1/query_range');
    url.searchParams.set('query',query);url.searchParams.set('start',String(BigInt(Date.now()-10*60000)*1000000n));url.searchParams.set('end',String(BigInt(Date.now()+1000)*1000000n));url.searchParams.set('limit','1000');
    const result=await json(url.toString());
    logs=[];
    if(result){const data=object(object(result).data);if(Array.isArray(data.result))for(const stream of data.result){const values=object(stream).values;if(Array.isArray(values))for(const entry of values)if(Array.isArray(entry)&&typeof entry[1]==='string'){try{logs.push(object(JSON.parse(entry[1])));}catch{}}}}
    const rows=objects(trace);
    const services=new Set(rows.filter(row=>row.key==='service.name').map(row=>object(row.value).stringValue));
    const names=new Set(rows.filter(row=>typeof row.name==='string').map(row=>row.name));
    if(['gateway','identity','order','inventory','payment','notification'].every(service=>services.has(service))&&names.has('order.process')&&logs.some(row=>row.event==='payment.delivered'&&row.order_id===confirmedOrderID)&&logs.some(row=>row.event==='payment.delivery_failed')&&logs.some(row=>row.event==='email.processed'&&row.status==='pending'))break;
    if(attempt===59)assert.fail('Stored order trace, failure/retry logs or service coverage is incomplete');
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  const rows=objects(trace);const spans=rows.filter(row=>typeof row.name==='string'&&(typeof row.spanId==='string'||typeof row.spanID==='string'));
  assert.ok(spans.length>0,'Tempo returned no spans');
  assert.ok(rows.some(row=>row.code==='STATUS_CODE_ERROR'||row.code===2),'Tempo did not retain real failure status');
  assert.ok(logs.every(row=>typeof row.message==='string' && row.message.length>0),'Stored logs are missing readable messages');
  assert.ok(logs.every(row=>row.source==='integration'),'Verification activity must be distinguishable from ordinary application logs');
  assert.ok(logs.some(row=>row.event==='rpc.failed' && typeof row.error_message==='string' && typeof row.order_id==='string'),'Failed RPC evidence is missing error context and business identity');
  assert.ok(logs.some(row=>row.event==='email.processed' && row.status==='pending' && row.error_code==='simulated_provider_unavailable' && row.retryable===true),'Email retry evidence is missing provider failure context');
  const evidence=JSON.stringify({trace,logs});
  for(const secret of secrets)if(secret)assert.equal(evidence.includes(secret),false,'Private content reached stored evidence');
  const password=process.env.INCIDENT_SYSTEM_GRAFANA_ADMIN_PASSWORD;assert.ok(password);
  const auth={Authorization:`Basic ${Buffer.from('admin:'+password).toString('base64')}`};
  for(const uid of ['loki','tempo']){
    const source=await json(`http://127.0.0.1:13000/api/datasources/uid/${uid}`,auth);assert.ok(source);assert.equal(object(source).uid,uid);
    const health=await json(`http://127.0.0.1:13000/api/datasources/uid/${uid}/health`,auth);assert.ok(health);assert.equal(object(health).status,'OK');
  }
  const loki=object(await json('http://127.0.0.1:13000/api/datasources/uid/loki',auth));
  const derived=object(loki.jsonData).derivedFields;assert.ok(Array.isArray(derived));
  const field=object(derived[0]);assert.equal(field.datasourceUid,'tempo');assert.equal(field.url,'${__value.raw}');
  const linked=logs.find(row=>row.trace_id===traceID);assert.ok(linked);
  const match=new RegExp(String(field.matcherRegex)).exec(JSON.stringify(linked));assert.equal(match?.[1],traceID,'Provisioned log-to-trace link does not extract the actual trace');
  console.log(JSON.stringify({event:'observability.verified',trace_id:traceID,order_id:confirmedOrderID,stored_spans:spans.length,stored_logs:logs.length,grafana:'http://localhost:13000'}));
}

export async function prometheusQuery(expression: string): Promise<Record<string, unknown>[]> {
  const url = new URL('http://127.0.0.1:19090/api/v1/query');
  url.searchParams.set('query', expression);
  const result = await json(url.toString());
  assert.ok(result, 'Prometheus query failed');
  const data = object(object(result).data);
  assert.ok(Array.isArray(data.result));
  return data.result.map(object);
}
export async function awaitMetric(expression: string, description: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const rows = await prometheusQuery(expression);
    if (rows.length) return rows;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.fail(`Prometheus did not observe ${description}`);
}
export async function verifyStoredMetrics(started: number, secrets: string[]) {
  // Heartbeats select only processes from this run. A process-instance resource
  // distinguishes cumulative counters across servers, publishers and restarts.
  const current = `on(job,instance) (max_over_time(incident_system_process_heartbeat_seconds{source="integration"}[5m]) >= ${started})`;
  const recent = (name: string, labels = '') => `max_over_time(${name}{source="integration"${labels ? ','+labels : ''}}[5m]) and ${current}`;
  const counts = await awaitMetric(recent('incident_system_operations_total'), 'completed operations');
  const services = new Set(counts.map(row => object(row.metric).service_name));
  for (const service of ['gateway','identity','order','inventory','payment','notification']) assert.ok(services.has(service), `Missing ${service} operation metrics`);
  await awaitMetric(`(${recent('incident_system_operations_total','outcome="server_error"')}) > 0`, 'real failed operations');
  await awaitMetric(`(${recent('incident_system_operation_duration_seconds_count')}) > 0`, 'latency histograms');
  await awaitMetric(`(${recent('incident_system_outbox_claims_total','attempt="retry"')}) > 0`, 'publisher retry claims');
  await awaitMetric(`(${recent('incident_system_outbox_results_total','outcome="retry"')}) > 0`, 'publication failure recovery');
  for (const outcome of ['sent','pending','duplicate']) await awaitMetric(`(${recent('incident_system_notification_results_total',`outcome="${outcome}"`)}) > 0`, `notification ${outcome} results`);
  const series = await prometheusQuery(`{__name__=~"incident_system_.+",source="integration"} and ${current}`);
  const allowed = new Set(['__name__','job','instance','service_name','source','process_role','operation','protocol','outcome','attempt','le','otel_scope_name','otel_scope_version']);
  for (const row of series) for (const key of Object.keys(object(row.metric))) assert.ok(allowed.has(key), `Unexpected metric label ${key}`);
  const serialized = JSON.stringify(series);
  for (const secret of secrets) if (secret) assert.equal(serialized.includes(secret), false, 'Private content reached metric labels');
  const password = process.env.INCIDENT_SYSTEM_GRAFANA_ADMIN_PASSWORD; assert.ok(password);
  const health = await json('http://127.0.0.1:13000/api/datasources/uid/prometheus/health', {Authorization: `Basic ${Buffer.from('admin:'+password).toString('base64')}`});
  assert.ok(health); assert.equal(object(health).status, 'OK');
  console.log(JSON.stringify({event:'metrics.verified',services:services.size,checked_series:series.length,prometheus:'http://localhost:19090'}));
}
