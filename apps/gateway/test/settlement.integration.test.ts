import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createServer as createSocket} from 'node:net';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {credentials, Metadata, status} from '@grpc/grpc-js';
import {OrderServiceClient} from '../../../packages/contracts/gen/ts/incident/order/v1/order_service.js';
import {paymentDatabaseConfig} from '../../payment/src/config.ts';
import {identityDatabaseConfig} from '../../identity/src/config.ts';
import {databaseConfig} from '../../../scripts/database/database.ts';
import {signProviderBody} from '../../payment/src/payments/provider-signature.ts';
import {OutboxPublisher} from '../../payment/src/payments/outbox.publisher.ts';
import {OutboxRepository} from '../../payment/src/payments/outbox.repository.ts';
import {qstashConnection} from '../../../packages/qstash/config.ts';
import {startQStashContainer} from '../../../scripts/qstash.ts';
import {object, start, stop, type Running} from '../../../scripts/integration.ts';
import {serviceEnvironment} from '../../../scripts/services.ts';

async function freePort() {
  const socket=createSocket();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const address=socket.address();assert.ok(address && typeof address!=='string');
  await new Promise<void>((resolve,reject)=>socket.close(error=>error?reject(error):resolve()));return address.port;
}
async function until(check:()=>Promise<boolean>, message:string) {
  for(let i=0;i<150;i++){if(await check())return;await delay(100);}assert.fail(message);
}

test('QStash payment delivery finalizes orders after Inventory/refund acknowledgement with durable retry recovery', {timeout:120000},async()=>{
  const fixture=randomUUID().replaceAll('-','');
  const orderDatabase=`incident_system_order_test_${fixture}`,paymentDatabase=`incident_system_payment_test_${fixture}`;
  const orderConfig={...databaseConfig(),database:orderDatabase,user:process.env.INCIDENT_SYSTEM_ORDER_DATABASE_USER??'incident_system_order',password:process.env.INCIDENT_SYSTEM_ORDER_DATABASE_PASSWORD};
  const paymentConfig={...paymentDatabaseConfig(),database:paymentDatabase};
  const admin=new Pool({...databaseConfig(),database:'postgres',user:'postgres',password:process.env.INCIDENT_SYSTEM_DATABASE_ADMIN_PASSWORD,max:1});
  const identities=new Pool(identityDatabaseConfig());
  const children:Running[]=[];const databases:string[]=[];const users:string[]=[];
  let orders:Pool|undefined,payments:Pool|undefined,local:Awaited<ReturnType<typeof startQStashContainer>>|undefined,rpc:OrderServiceClient|undefined;
  const previousMode=process.env.INCIDENT_SYSTEM_QSTASH_MODE;process.env.INCIDENT_SYSTEM_QSTASH_MODE='local';
  const captures:{id:string;raw:string;signature:string;status:number}[]=[];
  let gatewayBase='';
  // Capture genuine signed deliveries without logging their bodies or signatures.
  // The proxy's one-second retry hint keeps injected failures bounded in this check.
  const proxy=createServer((request,response)=>{
    void(async()=>{
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk)));
      const raw=Buffer.concat(chunks).toString();const signature=String(request.headers['upstash-signature']??'');
      const result=await fetch(gatewayBase+'/events/payment',{method:'POST',headers:{'Content-Type':'application/json','Upstash-Signature':signature},body:raw,signal:AbortSignal.timeout(5000)});
      await result.arrayBuffer();
      let id='';try{id=String(object(JSON.parse(raw)).id);}catch{}
      captures.push({id,raw,signature,status:result.status});
      if(result.status===503)response.setHeader('Retry-After','1');response.writeHead(result.status);response.end();
    })().catch(()=>{response.setHeader('Retry-After','1');response.writeHead(503);response.end();});
  });
  const sku='settlement-item';
  const inventorySettings={INCIDENT_SYSTEM_INVENTORY_GRPC_ADDRESS:'127.0.0.1:0',INCIDENT_SYSTEM_INVENTORY_REDIS_PREFIX:`incident-system:inventory:test-${fixture}:`,INCIDENT_SYSTEM_INVENTORY_HOLD_TTL:'15m'};
  function stock(remove=false){execFileSync(process.execPath,['dist/scripts/services.js','inventory',remove?'reset':'seed','--sku',sku,'--stock','20',...(remove?['--remove']:[])],{env:serviceEnvironment('inventory',inventorySettings),stdio:'pipe'});}
  const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
  try{
    for(const [name,owner,config,migrations] of [
      [orderDatabase,orderConfig.user,'apps/order/tern.conf','apps/order/internal/orders/migrations'],
      [paymentDatabase,paymentConfig.user??'incident_system_payment','apps/payment/tern.conf','apps/payment/src/payments/migrations'],
    ]){
      assert.ok(name && owner && config && migrations);
      await admin.query(`CREATE DATABASE ${quote(name)} OWNER ${quote(owner)}`);databases.push(name);
      await admin.query(`REVOKE ALL ON DATABASE ${quote(name)} FROM PUBLIC`);
      execFileSync('bin/tern',['migrate','-c',config,'-m',migrations],{env:{...process.env,INCIDENT_SYSTEM_ORDER_DATABASE_NAME:orderDatabase,INCIDENT_SYSTEM_PAYMENT_DATABASE_NAME:paymentDatabase},stdio:'pipe'});
    }
    orders=new Pool(orderConfig);payments=new Pool(paymentConfig);
    const orderDB=orders,paymentDB=payments;
    stock();
    const qstashPort=await freePort();local=await startQStashContainer(qstashPort);
    const connection=qstashConnection();
    await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));const proxyAddress=proxy.address();assert.ok(proxyAddress && typeof proxyAddress!=='string');
    const callbackBase=`http://host.docker.internal:${proxyAddress.port}`;
    const publisher=new OutboxPublisher(new OutboxRepository(paymentDB),{baseURL:`http://127.0.0.1:${qstashPort}`,token:connection.token,destination:callbackBase+'/events/payment'});
    const identity=await start('identity',{INCIDENT_SYSTEM_IDENTITY_GRPC_ADDRESS:'127.0.0.1:0'},children);
    const orderSettings={INCIDENT_SYSTEM_ORDER_DATABASE_NAME:orderDatabase,INCIDENT_SYSTEM_ORDER_GRPC_ADDRESS:'127.0.0.1:0',INCIDENT_SYSTEM_ORDER_IDENTITY_ADDRESS:identity.address};
    let order=await start('order',orderSettings,children);
    let inventory=await start('inventory',inventorySettings,children);
    const payment=await start('payment',{INCIDENT_SYSTEM_PAYMENT_DATABASE_NAME:paymentDatabase,INCIDENT_SYSTEM_PAYMENT_GRPC_ADDRESS:'127.0.0.1:0',INCIDENT_SYSTEM_PAYMENT_HTTP_ADDRESS:'127.0.0.1:0',INCIDENT_SYSTEM_PAYMENT_ORDER_ADDRESS:order.address,INCIDENT_SYSTEM_PAYMENT_INVENTORY_ADDRESS:inventory.address},children);
    const gateway=await start('gateway',{INCIDENT_SYSTEM_GATEWAY_HTTP_ADDRESS:'127.0.0.1:0',INCIDENT_SYSTEM_GATEWAY_IDENTITY_ADDRESS:identity.address,INCIDENT_SYSTEM_GATEWAY_ORDER_ADDRESS:order.address,INCIDENT_SYSTEM_GATEWAY_INVENTORY_ADDRESS:inventory.address,INCIDENT_SYSTEM_GATEWAY_PAYMENT_ADDRESS:payment.address,INCIDENT_SYSTEM_CALLBACK_BASE_URL:callbackBase},children);
    gatewayBase=`http://${gateway.address}`;
    async function request(path:string,token?:string,body?:unknown,post=false){
      const headers:Record<string,string>={};if(token)headers.Authorization=`Bearer ${token}`;if(body!==undefined)headers['Content-Type']='application/json';
      const response=await fetch(gatewayBase+path,{method:post||body!==undefined?'POST':'GET',headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});
      return {status:response.status,body:object(await response.json())};
    }
    const email=`settlement-${fixture}@example.test`;
    const account=await request('/auth/signup',undefined,{email,password:'Settlement-integration-password-42'});assert.equal(account.status,201);
    users.push(String(object(account.body.user).id));const token=String(account.body.token);
    rpc=new OrderServiceClient(order.address,credentials.createInsecure());
    await assert.rejects(new Promise((resolve,reject)=>rpc!.prepareOrderSettlement({id:randomUUID(),eventId:randomUUID(),payloadHash:'a'.repeat(64)},new Metadata(),{deadline:Date.now()+2000},(error,result)=>error?reject(error):resolve(result))),{code:status.UNAUTHENTICATED});
    const unauth=await fetch(gatewayBase+'/events/payment',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(unauth.status,401);await unauth.arrayBuffer();
    async function create(outcome:'succeeded'|'failed'){
      const created=await request('/orders',token,{sku,quantity:1});assert.equal(created.status,201);const id=String(created.body.id);
      assert.equal((await request(`/orders/${id}/reservation`,token,undefined,true)).status,200);
      const attempt=await request(`/orders/${id}/payment`,token,undefined,true);assert.equal(attempt.status,200);
      const body=Buffer.from(JSON.stringify({event_id:randomUUID(),payment_id:attempt.body.id,outcome}));
      const timestamp=String(Math.floor(Date.now()/1000));
      const response=await fetch(`http://${payment.httpAddress}/webhooks/provider`,{method:'POST',headers:{'Content-Type':'application/json','X-Payment-Timestamp':timestamp,'X-Payment-Signature':signProviderBody(body,timestamp,process.env.INCIDENT_SYSTEM_PAYMENT_WEBHOOK_SECRET??'')},body});
      assert.equal(response.status,200);await response.arrayBuffer();
      const {rows:[event]}=await paymentDB.query('SELECT id,payload FROM payments.outbox WHERE payment_id=$1',[attempt.body.id]);
      return {id,paymentId:String(attempt.body.id),eventId:String(event.id),payload:object(event.payload)};
    }
    async function state(id:string){return (await orderDB.query('SELECT status FROM orders.orders WHERE id=$1',[id])).rows[0].status;}
    async function completed(id:string,target:string){await until(async()=>await state(id)===target,`Order did not become ${target}`);}
    async function replay(capture:typeof captures[number],raw=capture.raw){const response=await fetch(gatewayBase+'/events/payment',{method:'POST',headers:{'Content-Type':'application/json','Upstash-Signature':capture.signature},body:raw});await response.arrayBuffer();return response.status;}
    async function failOutbox(id:string){await orderDB.query(`ALTER TABLE orders.outbox ADD CONSTRAINT fixture_failure CHECK(order_id <> '${id}'::uuid)`);}
    async function unblockOutbox(){await orderDB.query('ALTER TABLE orders.outbox DROP CONSTRAINT fixture_failure');}

    const confirmed=await create('succeeded');await failOutbox(confirmed.id);
    assert.equal(await publisher.runBatch(new AbortController().signal),1);
    await until(async()=>captures.some(c=>c.id===confirmed.eventId && c.status===503),'Missing SQL failure response');
    assert.equal(await state(confirmed.id),'pending');
    assert.equal((await request(`/orders/${confirmed.id}/reservation`,token)).body.state,'committed');
    assert.equal((await orderDB.query('SELECT processed_at FROM orders.inbox WHERE event_id=$1',[confirmed.eventId])).rows[0].processed_at,null);
    assert.ok((await paymentDB.query('SELECT published_at FROM payments.outbox WHERE id=$1',[confirmed.eventId])).rows[0].published_at,'QStash acceptance is separate from processing');
    await unblockOutbox();await completed(confirmed.id,'confirmed');
    await until(async()=>captures.some(c=>c.id===confirmed.eventId && c.status===204),'QStash retry did not complete');
    const capture=captures.find(c=>c.id===confirmed.eventId);assert.ok(capture);
    assert.equal(await replay(capture,capture.raw+' '),401);
    assert.deepEqual(await Promise.all(Array.from({length:4},()=>replay(capture))),[204,204,204,204]);
    const {rows:[final]}=await orderDB.query('SELECT payload FROM orders.outbox WHERE order_id=$1',[confirmed.id]);
    assert.equal(final.payload.type,'order.confirmed');assert.equal(final.payload.data.recipient_email,email);
    assert.equal((await request(`/orders/${confirmed.id}`,token)).body.status,'confirmed');
    assert.equal((await request(`/orders/${confirmed.id}/reservation`,token,undefined,true)).status,409);

    const failed=await create('failed');await publisher.runBatch(new AbortController().signal);await completed(failed.id,'failed');
    assert.equal((await request(`/orders/${failed.id}/reservation`,token)).body.state,'released');

    const recovery=await create('succeeded');await stop(inventory.process);await publisher.runBatch(new AbortController().signal);
    await until(async()=>captures.some(c=>c.id===recovery.eventId && c.status===503),'Inventory outage did not fail delivery');
    assert.equal(await state(recovery.id),'pending');
    assert.equal((await paymentDB.query('SELECT count(*)::int AS count FROM payments.refunds')).rows[0].count,0,'Transport failure cannot trigger a refund');
    inventory=await start('inventory',{...inventorySettings,INCIDENT_SYSTEM_INVENTORY_GRPC_ADDRESS:inventory.address},children);
    await until(async()=>(await request('/health/ready')).status===200,'Inventory did not reconnect');
    const recoveryCapture=captures.find(c=>c.id===recovery.eventId);assert.ok(recoveryCapture);
    assert.deepEqual(await Promise.all(Array.from({length:4},()=>replay(recoveryCapture))),[204,204,204,204]);await completed(recovery.id,'confirmed');

    await stop(inventory.process);
    inventory=await start('inventory',{...inventorySettings,INCIDENT_SYSTEM_INVENTORY_GRPC_ADDRESS:inventory.address,INCIDENT_SYSTEM_INVENTORY_HOLD_TTL:'2s'},children);
    await until(async()=>(await request('/health/ready')).status===200,'Inventory did not reconnect for expiry');
    const refunded=await create('succeeded');await delay(2100);await failOutbox(refunded.id);
    await publisher.runBatch(new AbortController().signal);
    await until(async()=>captures.some(c=>c.id===refunded.eventId && c.status===503),'Missing refund-to-Order interruption');
    assert.equal(await state(refunded.id),'pending');
    const refund=(await paymentDB.query('SELECT * FROM payments.refunds WHERE payment_id=$1',[refunded.paymentId])).rows[0];assert.ok(refund);
    await unblockOutbox();await completed(refunded.id,'refunded');
    assert.equal((await request(`/orders/${refunded.id}/reservation`,token)).body.state,'expired');
    assert.equal((await paymentDB.query('SELECT status FROM payments.attempts WHERE id=$1',[refunded.paymentId])).rows[0].status,'succeeded');
    assert.equal((await paymentDB.query('SELECT count(*)::int AS count FROM payments.refunds')).rows[0].count,1);
    // Even a genuine QStash signature cannot turn forged financial fields into facts.
    const forgedId=randomUUID();
    const forged={...confirmed.payload,id:forgedId,data:{...object(confirmed.payload.data),amount_minor:999999}};
    for(const [payload,destination] of [[forged,callbackBase+'/events/payment'],[confirmed.payload,callbackBase+'/wrong-destination']] as const){
      const response=await fetch(`http://127.0.0.1:${qstashPort}/v2/batch`,{method:'POST',headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json'},body:JSON.stringify([{destination,body:JSON.stringify(payload),headers:{'Content-Type':'application/json','Upstash-Retries':'0'}}])});
      assert.ok(response.ok);await response.arrayBuffer();
    }
    await until(async()=>captures.some(c=>c.id===forgedId && c.status===409),'Forged financial fields were not rejected');
    await until(async()=>captures.some(c=>c.id===confirmed.eventId && c.status===401),'Wrong signed destination was not rejected');
    assert.equal((await orderDB.query('SELECT count(*)::int AS count FROM orders.inbox WHERE event_id=$1',[forgedId])).rows[0].count,0);
    const {rows:[counts]}=await orderDB.query('SELECT count(*)::int AS events,count(DISTINCT order_id)::int AS orders FROM orders.outbox');assert.deepEqual(counts,{events:4,orders:4});
    assert.equal((await orderDB.query('SELECT count(*)::int AS count FROM orders.inbox WHERE processed_at IS NOT NULL')).rows[0].count,4);
    const acceptedMetadata=new Metadata();acceptedMetadata.set('x-service-token',process.env.INCIDENT_SYSTEM_ORDER_SERVICE_TOKEN??'');
    await assert.rejects(new Promise((resolve,reject)=>rpc!.prepareOrderSettlement({id:failed.id,eventId:confirmed.eventId,payloadHash:'b'.repeat(64)},acceptedMetadata,{deadline:Date.now()+2000},(error,result)=>error?reject(error):resolve(result))),{code:status.ALREADY_EXISTS});
    // Persisted receipt/final state survive the Order process, not merely a cache.
    rpc.close();await stop(order.process);order=await start('order',{...orderSettings,INCIDENT_SYSTEM_ORDER_GRPC_ADDRESS:order.address},children);
    await until(async()=>await replay(capture)===204,'Duplicate did not recover after Order restart');
    for(const child of children)await stop(child);
    const logs=children.map(c=>c.output).join('\n');
    for(const secret of [token,process.env.INCIDENT_SYSTEM_ORDER_SERVICE_TOKEN,process.env.INCIDENT_SYSTEM_PAYMENT_SERVICE_TOKEN,process.env.INCIDENT_SYSTEM_PAYMENT_WEBHOOK_SECRET])if(secret)assert.equal(logs.includes(secret),false);
  }finally{
    rpc?.close();await new Promise<void>(resolve=>proxy.close(()=>resolve()));
    await local?.stop();for(const child of children)await stop(child);
    stock(true);
    await orders?.end();await payments?.end();
    // Require owned clients to close; dropping fixtures must not terminate live connections.
    for(const name of databases)await admin.query(`DROP DATABASE ${quote(name)}`);
    await identities.query('DELETE FROM identity.users WHERE id=ANY($1::uuid[])',[users]);
    await identities.end();await admin.end();
    if(previousMode===undefined)delete process.env.INCIDENT_SYSTEM_QSTASH_MODE;else process.env.INCIDENT_SYSTEM_QSTASH_MODE=previousMode;
  }
});
