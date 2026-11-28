import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, readdirSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {failureFields} from '../packages/telemetry/ts/logging.ts';
import {capturedLog, logCapture} from './log-capture.ts';

test('log capture admits only selected operational fields and excludes span dumps', () => {
  const line = capturedLog(JSON.stringify({time:'2026-11-26T12:00:00Z',service:'untrusted',level:'WARN',message:'Payment event could not be settled',error_type:'rpc',payment_id:'payment-fixture',msg:'payment.delivery_failed',order_id:'order-fixture',trace_id:'0123456789abcdef0123456789abcdef',password:'private-password',authorization:'Bearer private-token',body:'private-content',email:'private@example.test',reason:'raw transport error with credentials',duration_ms:42}), 'gateway');
  assert.ok(line);const record:unknown=JSON.parse(line);
  assert.deepEqual(record,{time:'2026-11-26T12:00:00Z',service:'gateway',process_role:'server',source:'application',event:'payment.delivery_failed',level:'warn',payment_id:'payment-fixture',message:'Payment event could not be settled',error_type:'rpc',order_id:'order-fixture',trace_id:'0123456789abcdef0123456789abcdef',duration_ms:42});
  const database = capturedLog(JSON.stringify({event:'webhook.failed',message:'Payment provider webhook failed',...failureFields({code:'23514',message:'private SQL and customer@example.test',detail:'private row contents'})}), 'payment');
  assert.ok(database?.includes('23514'));
  assert.ok(database?.includes('Database rejected a write'));
  assert.ok(!database?.includes('private'));
  assert.ok(!database?.includes('customer@example.test'));
  assert.equal(capturedLog('unstructured raw error with credentials','payment'),undefined);
  assert.equal(capturedLog(JSON.stringify({event:'trace.completed'}),'payment'),undefined);
});

test('capture rotates files using discoverable bounded segment names', () => {
  const directory=mkdtempSync(join(tmpdir(),'incident-system-capture-'));
  const capture=logCapture('gateway','server',directory);
  try {
    const line=Buffer.from(JSON.stringify({event:'request.failed',request_id:'x'.repeat(256),operation:'x'.repeat(256),code:'unavailable'})+'\n');
    for(let i=0;i<5000;i++)capture.write(line);
    const files=readdirSync(directory);
    assert.ok(files.some(name=>name.endsWith('.1.jsonl')));
    assert.ok(files.every(name=>/^gateway-server-\d+(?:\.[1-3])?\.jsonl$/.test(name)));
    assert.ok(files.every(name=>statSync(join(directory,name)).size<=2*1024*1024));
  } finally {capture.close();rmSync(directory,{recursive:true});}
});
