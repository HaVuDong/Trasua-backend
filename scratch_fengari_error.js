const fengari = require('fengari');
const { lua, lauxlib, to_luastring } = fengari;

const L = lauxlib.luaL_newstate();
const res = lauxlib.luaL_dostring(L, to_luastring('error("test error")'));
console.log('Result:', res);
if (res !== 0) {
  // Let's see how we can extract the error
  const err = lua.lua_tostring;
  console.log('lua_tostring exists:', typeof err);
  const errVal = lua.lua_tolstring(L, -1);
  console.log('errVal type:', typeof errVal, errVal ? errVal.constructor.name : 'null');
  if (errVal) {
    console.log('js string via fengari.to_jsstring:', fengari.to_jsstring(errVal));
  }
}
