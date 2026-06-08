const IORedisMock = require('ioredis-mock');
const redis = new IORedisMock();

console.log('zpopmin function:', redis.zpopmin.toString());
const p = redis.zpopmin('foo', 1);
console.log('zpopmin return type:', p ? p.constructor.name : typeof p);
