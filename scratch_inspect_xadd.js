const IORedisMock = require('ioredis-mock');
const redis = new IORedisMock();

console.log('redis.xadd exists:', typeof redis.xadd);
console.log('redis.xaddBuffer exists:', typeof redis.xaddBuffer);
console.log('redis.xadd code:', redis.xadd ? redis.xadd.toString() : 'undefined');
