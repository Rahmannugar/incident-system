import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Pool} from 'pg';
import {notificationDatabaseConfig} from '../src/config.ts';
import {NotificationService} from '../src/notifications/notifications.service.ts';
import {NotificationRepository} from '../src/notifications/notifications.repository.ts';
import {SimulatedEmailProvider} from '../src/notifications/email-provider.ts';
import {DeliveryConflict, finalOrderEvent, type FinalOrderEvent} from '../src/notifications/notifications.types.ts';
import {serviceEnvironment} from '../../../scripts/services.ts';

test('Notification owns durable email results, conflict protection and retryable provider failures', {timeout:30000},async()=>{
  const database=notificationDatabaseConfig();const name=`incident_system_notification_test_${randomUUID().replaceAll('-','')}`;
  const admin=new Pool({...database,user:'postgres',password:process.env.INCIDENT_SYSTEM_DATABASE_ADMIN_PASSWORD,database:'postgres',max:1});
  let created=false;let pool:Pool|undefined;
  try{
    const owner=(database.user??'incident_system_notification').replaceAll('"','""');
    await admin.query(`CREATE DATABASE "${name}" OWNER "${owner}"`);created=true;await admin.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
    execFileSync('bin/tern',['migrate','-c','apps/notification/tern.conf','-m','apps/notification/src/notifications/migrations'],{env:{...process.env,INCIDENT_SYSTEM_NOTIFICATION_DATABASE_NAME:name},stdio:'pipe'});
    pool=new Pool({...database,database:name});
    const repository=new NotificationService(new NotificationRepository(pool),new SimulatedEmailProvider(2));
    function event(recipient:string|null='customer@example.test'):FinalOrderEvent{return {id:randomUUID(),type:'order.confirmed',version:1,occurred_at:new Date().toISOString(),request_id:randomUUID(),data:{order_id:randomUUID(),payment_id:randomUUID(),status:'confirmed',recipient_email:recipient}};}
    const hash=(value:FinalOrderEvent)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const value=event();
    assert.ok(finalOrderEvent(JSON.stringify(value)));
    assert.equal(finalOrderEvent(JSON.stringify({...value,data:{...value.data,recipient_email:42}})),undefined);
    const results=await Promise.all(Array.from({length:6},()=>repository.receive(value,hash(value),()=>{})));
    assert.equal(results.filter(row=>row.status==='pending').length,2);
    const {rows:[sent]}=await pool.query('SELECT * FROM notifications.deliveries WHERE event_id=$1',[value.id]);
    assert.equal(sent.status,'sent');assert.equal(sent.attempts,3);assert.equal(sent.provider_message_id,`simulated_email_${value.id}`);
    assert.equal(sent.subject,'Order confirmed');assert.ok(sent.body.includes(value.data.order_id));
    await assert.rejects(repository.receive({...value,data:{...value.data,recipient_email:'other@example.test'}},'b'.repeat(64),()=>{}),DeliveryConflict);
    const reusedOrder={...value,id:randomUUID()};await assert.rejects(repository.receive(reusedOrder,hash(reusedOrder),()=>{}),DeliveryConflict);
    const missing=event(null);assert.equal((await repository.receive(missing,hash(missing),()=>{})).status,'failed');
    const {rows:[failed]}=await pool.query('SELECT status,error_code,provider_message_id FROM notifications.deliveries WHERE event_id=$1',[missing.id]);
    assert.deepEqual(failed,{status:'failed',error_code:'recipient_missing',provider_message_id:null});
    assert.equal((await repository.receive(missing,hash(missing),()=>{})).duplicate,true);
    const interrupted=event();let calls=0;
    await assert.rejects(repository.receive(interrupted,hash(interrupted),()=>{if(++calls===2)throw new Error('cancelled');}),/cancelled/);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM notifications.deliveries WHERE event_id=$1',[interrupted.id])).rows[0].count,0);
    const isolated=serviceEnvironment('notification');
    for(const key of ['INCIDENT_SYSTEM_ORDER_DATABASE_PASSWORD','INCIDENT_SYSTEM_DATABASE_ADMIN_PASSWORD','INCIDENT_SYSTEM_QSTASH_TOKEN','INCIDENT_SYSTEM_PAYMENT_WEBHOOK_SECRET'])assert.equal(isolated[key],undefined);
    const other=new Pool({...database,database:name,user:process.env.INCIDENT_SYSTEM_ORDER_DATABASE_USER,password:process.env.INCIDENT_SYSTEM_ORDER_DATABASE_PASSWORD});
    try{await assert.rejects(other.query('SELECT 1'),{code:'42501'});}finally{await other.end();}
  }finally{
    await pool?.end();if(created)await admin.query(`DROP DATABASE "${name}"`);await admin.end();
  }
});
