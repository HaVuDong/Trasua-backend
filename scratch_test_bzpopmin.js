const IORedisMock = require('ioredis-mock');
const asCallback = require('@ioredis/as-callback').default || require('@ioredis/as-callback');

function makeCommandWrapper(commandFn) {
  return function (...args) {
    let lastArgIndex = args.length - 1;
    let callback = args[lastArgIndex];
    if (typeof callback === 'function') {
      args.length = lastArgIndex;
    } else {
      callback = undefined;
    }
    const promise = Promise.resolve().then(() => commandFn.apply(this, args));
    return asCallback(promise, callback);
  };
}

IORedisMock.prototype.bzpopmin = makeCommandWrapper(function (...args) {
  const keys = args.slice(0, -1);
  for (const key of keys) {
    if (this.data.has(key)) {
      const res = this.zpopmin(key, 1);
      // Since zpopmin is a wrapped command returning a promise, wait, zpopmin returns a promise!
      // Ah! Inside our function, calling `this.zpopmin(key, 1)` returns a Promise!
      // So we must await it, or handle it as a Promise!
      // Yes! Since our wrapper resolves the promise returned by the commandFn, we can make commandFn an async function!
    }
  }
  return null;
});

// Let's rewrite it as async!
IORedisMock.prototype.bzpopmin = makeCommandWrapper(async function (...args) {
  const keys = args.slice(0, -1);
  for (const key of keys) {
    if (this.data.has(key)) {
      const res = await this.zpopmin(key, 1);
      if (res && res.length >= 2) {
        return [key, res[0], res[1]];
      }
    }
  }
  return null;
});

IORedisMock.prototype.bzpopminBuffer = makeCommandWrapper(async function (...args) {
  const res = await this.bzpopmin.apply(this, args);
  if (!res) return null;
  return [
    Buffer.from(res[0]),
    Buffer.from(res[1]),
    Buffer.from(String(res[2]))
  ];
});

const redis = new IORedisMock();
redis.zadd('myzset', 1, 'one', 2, 'two').then(() => {
  return redis.bzpopmin('myzset', 0);
}).then(res => {
  console.log('bzpopmin result:', res);
  return redis.bzpopminBuffer('myzset', 0);
}).then(res => {
  console.log('bzpopminBuffer result:', res);
}).catch(err => {
  console.error('Error:', err);
});
