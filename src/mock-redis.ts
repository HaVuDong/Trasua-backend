// Intercept require('ioredis') and replace it with ioredis-mock to run BullMQ entirely in-memory.
const fengari = require('fengari');
const fengariInterop = require('fengari-interop');
const msgpack = require('msgpackr');
const IORedisMock = require('ioredis-mock');
const asCallback = require('@ioredis/as-callback').default || require('@ioredis/as-callback');

// Helper to wrap commands like ioredis-mock does to return promises and support callbacks
function makeCommandWrapper(commandFn: any) {
  return function (this: any, ...args: any[]) {
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

IORedisMock.prototype.bzpopmin = makeCommandWrapper(async function (this: any, ...args: any[]) {
  const keys = args.slice(0, -1);
  for (const key of keys) {
    if (this.data.has(key)) {
      const res = await this.zpopmin(key, 1);
      if (res && res.length >= 2) {
        return [key, res[0], res[1]];
      }
    }
  }
  // Wait to prevent tight loop / event loop starvation
  const timeout = parseFloat(args[args.length - 1]) || 0;
  const delay = timeout > 0 ? Math.min(timeout * 1000, 1000) : 1000;
  await new Promise(resolve => setTimeout(resolve, delay));
  return null;
});

IORedisMock.prototype.bzpopminBuffer = makeCommandWrapper(async function (this: any, ...args: any[]) {
  const res = await this.bzpopmin.apply(this, args);
  if (!res) return null;
  return [
    Buffer.from(res[0]),
    Buffer.from(res[1]),
    Buffer.from(String(res[2]))
  ];
});

// Patch fengari.lauxlib.luaL_dostring to capture and print detailed Lua errors
if (fengari.lauxlib && !fengari.lauxlib.__patched) {
  fengari.lauxlib.__patched = true;
  const originalDostring = fengari.lauxlib.luaL_dostring;
  fengari.lauxlib.luaL_dostring = function (L: any, str: any) {
    const res = originalDostring.call(this, L, str);
    if (res !== 0) {
      try {
        const errStr = fengari.lua.lua_tostring(L, -1);
        const jsErr = errStr ? fengari.to_jsstring(errStr) : null;
        const interopErr = fengariInterop.tojs(L, -1);
        console.error('--- LUA ERROR DETECTED ---');
        console.error('Lua String Error:', jsErr);
        console.error('Interop Error:', interopErr);
        console.error('---------------------------');
      } catch (e) {
        console.error('Failed to parse Lua error message:', e);
      }
    }
    return res;
  };
}

// Patch fengariInterop.luaopen_js directly
if (fengariInterop && !fengariInterop.__patched) {
  fengariInterop.__patched = true;
  const originalLuaopenJs = fengariInterop.luaopen_js;
  fengariInterop.luaopen_js = function (L: any) {
    const res = originalLuaopenJs.call(this, L);
    try {
      // Register unpack function
      fengari.lua.lua_pushjsfunction(L, function (L_state: any) {
        try {
          const lua = fengari.lua;
          let data = lua.lua_tolstring(L_state, 1);
          if (!data) {
            data = fengariInterop.tojs(L_state, 1);
          }
          if (!data) {
            return 0;
          }
          const unpacked = msgpack.unpack(data);
          fengariInterop.push(L_state, unpacked);
          return 1;
        } catch (err) {
          console.error('cmsgpack.unpack error:', err);
          return 0;
        }
      });
      fengari.lua.lua_setglobal(L, fengari.to_luastring('__cmsgpack_unpack'));

      // Register pack function
      fengari.lua.lua_pushjsfunction(L, function (L_state: any) {
        try {
          const lua = fengari.lua;
          const value = fengariInterop.tojs(L_state, 1);
          const packed = msgpack.pack(value);
          lua.lua_pushlstring(L_state, packed, packed.length);
          return 1;
        } catch (err) {
          console.error('cmsgpack.pack error:', err);
          return 0;
        }
      });
      fengari.lua.lua_setglobal(L, fengari.to_luastring('__cmsgpack_pack'));

      // Register cjson decode function
      fengari.lua.lua_pushjsfunction(L, function (L_state: any) {
        try {
          const lua = fengari.lua;
          let data = lua.lua_tolstring(L_state, 1);
          if (!data) {
            data = fengariInterop.tojs(L_state, 1);
          }
          if (!data) {
            return 0;
          }
          let jsStr: string;
          if (typeof data === 'string') {
            jsStr = data;
          } else {
            jsStr = Buffer.from(data).toString('utf8');
          }
          const parsed = JSON.parse(jsStr);
          fengariInterop.push(L_state, parsed);
          return 1;
        } catch (err) {
          console.error('cjson.decode error:', err);
          return 0;
        }
      });
      fengari.lua.lua_setglobal(L, fengari.to_luastring('__cjson_decode'));

      // Register cjson encode function
      fengari.lua.lua_pushjsfunction(L, function (L_state: any) {
        try {
          const lua = fengari.lua;
          const value = fengariInterop.tojs(L_state, 1);
          const jsonStr = JSON.stringify(value);
          lua.lua_pushstring(L_state, fengari.to_luastring(jsonStr));
          return 1;
        } catch (err) {
          console.error('cjson.encode error:', err);
          return 0;
        }
      });
      fengari.lua.lua_setglobal(L, fengari.to_luastring('__cjson_encode'));

      // Create cmsgpack and cjson tables using a simple Lua string
      if (fengari.lauxlib.luaL_dostring(L, fengari.to_luastring(`
        cmsgpack = {
          unpack = __cmsgpack_unpack,
          pack = __cmsgpack_pack
        }
        cjson = {
          decode = __cjson_decode,
          encode = __cjson_encode
        }
      `)) !== 0) {
        console.error('Failed to setup cmsgpack/cjson tables in Lua:', fengari.lua.lua_tojsstring(L, -1));
      }
    } catch (err) {
      console.error('Failed to inject cmsgpack mock:', err);
    }
    return res;
  };
}

const Module = require('module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function (name: string) {
  if (name === 'ioredis') {
    return IORedisMock;
  }

  if (name === 'fengari-interop') {
    return fengariInterop;
  }

  return originalRequire.apply(this, arguments);
};
console.log('Redis mock module interceptor loaded successfully');





