local op, sku, id = ARGV[1], ARGV[2], ARGV[3]
local quantity, ttl, initial = tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6])
local function result(value) return cjson.encode(value) end
local function failure(code) return result({error=code}) end

-- Validate types before any writes: Lua is atomic but runtime errors do not roll back writes.
local expected = {'string', 'zset', 'hash', 'hash', 'string'}
for i=1,5 do
  local key = KEYS[i]
  local kind = redis.call('TYPE', key).ok
  if kind ~= 'none' and kind ~= expected[i] then return failure('corrupt_state') end
end
if op == 'reset' or op == 'remove' then
  -- Deliberate per-SKU demo reset; other SKUs and namespaces are untouched.
  local records = redis.call('HGETALL', KEYS[4])
  for i=1,#records,2 do
    if cjson.decode(records[i+1]).sku == sku then redis.call('HDEL', KEYS[4], records[i]) end
  end
  redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
  for i=6,#KEYS do redis.call('DEL', KEYS[i]) end
end
if op == 'remove' then return result({remaining=0, available=0}) end
if op == 'seed' or op == 'reset' then redis.call('SET', KEYS[1], initial, 'NX') end
local remaining = tonumber(redis.call('GET', KEYS[1]))
if remaining == nil then return failure('sku_not_found') end
local clock = redis.call('TIME')
local now = tonumber(clock[1])*1000 + math.floor(tonumber(clock[2])/1000)

-- Availability is unsold stock minus live holds, never a counter awaiting an expiry notification.
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)
for _, order in ipairs(expired) do redis.call('HDEL', KEYS[3], order) end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local held = 0
for _, value in ipairs(redis.call('HVALS', KEYS[3])) do held = held + tonumber(value) end
local available = remaining - held
if available < 0 then return failure('corrupt_state') end
if op == 'stock' or op == 'seed' or op == 'reset' then
  return result({remaining=remaining, available=available})
end
local encoded = redis.call('HGET', KEYS[4], id)
local reservation = encoded and cjson.decode(encoded) or nil
if reservation and (reservation.sku ~= sku or (op == 'reserve' and reservation.quantity ~= quantity)) then
  return failure('reservation_conflict')
end
local function save() redis.call('HSET', KEYS[4], id, cjson.encode(reservation)) end
if reservation and reservation.state == 'held' and (reservation.expires_at_unix_ms <= now or redis.call('EXISTS', KEYS[5]) == 0) then
  reservation.state = 'expired'
  redis.call('ZREM', KEYS[2], id)
  redis.call('HDEL', KEYS[3], id)
  save()
end
if op == 'reserve' then
  if reservation then
    if reservation.state == 'released' or reservation.state == 'expired' then return failure('reservation_closed') end
    return result({reservation=reservation})
  end
  if quantity > available then return failure('insufficient_stock') end
  -- Bound both the hot script's work and retained idempotency history for this prototype.
  if redis.call('ZCARD', KEYS[2]) >= 1000 or redis.call('HLEN', KEYS[4]) >= 10000 then return failure('inventory_capacity') end
  reservation = {order_id=id, sku=sku, quantity=quantity, state='held', expires_at_unix_ms=now+ttl}
  redis.call('SET', KEYS[5], '1', 'PX', ttl)
  redis.call('ZADD', KEYS[2], now+ttl, id)
  redis.call('HSET', KEYS[3], id, quantity)
  save()
elseif not reservation then return failure('reservation_not_found')
elseif op == 'commit' then
  if reservation.state == 'committed' then return result({reservation=reservation}) end
  if reservation.state ~= 'held' then return failure('reservation_closed') end
  redis.call('DECRBY', KEYS[1], reservation.quantity)
  redis.call('ZREM', KEYS[2], id)
  redis.call('HDEL', KEYS[3], id)
  redis.call('DEL', KEYS[5])
  reservation.state='committed'
  save()
elseif op == 'release' then
  if reservation.state == 'committed' then return failure('reservation_closed') end
  if reservation.state == 'held' then
    redis.call('ZREM', KEYS[2], id)
    redis.call('HDEL', KEYS[3], id)
    redis.call('DEL', KEYS[5])
    reservation.state='released'
    save()
  end
end
return result({reservation=reservation})
