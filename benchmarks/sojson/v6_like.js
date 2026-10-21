
var _0xabcd = ['SGVsbG8sIA==', 'IQ==', 'd29ybGQ=', 'eA=='];
(function(arr, n) {
  var r = function(x){ while(--x){ arr.push(arr.shift()); } };
  r(++n);
})(_0xabcd, 0x1);
var _0x12 = function(i, k) {
  i = i - 0x0;
  var s = _0xabcd[i];
  if (_0x12.decoded === undefined) {
    _0x12.b64 = function(d) {
      var t = Buffer ? Buffer.from(d, 'base64').toString('utf8') : atob(d);
      return t;
    };
    _0x12.decoded = true;
  }
  return _0x12.b64(s);
};
// self-defending stub (harmless pattern)
setInterval(function(){ /* debugger protect stub */ if(typeof console!=='undefined'&&console.clear){/*no-op*/} }, 4000);
function greet(name) {
  return _0x12('0x0') + name + _0x12('0x1');
}
function add(a,b){ return a+b; }
var result = { sum: add(20,22), hi: greet(_0x12('0x2')) };
if (typeof module !== 'undefined') module.exports = { greet, add, result, _0x12 };
