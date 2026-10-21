
function add(a, b) { return a + b; }
function greet(name) {
  var msg = "Hello, " + name + "!";
  if (name === "world") return msg + " (default)";
  return msg;
}
function sign(path, auth) {
  var s = path + "|" + auth + "|v1";
  var h = 0;
  for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return "x" + (h >>> 0).toString(16);
}
var result = { sum: add(20, 22), hi: greet("world"), sig: sign("/api/x", "tok") };
if (typeof module !== "undefined") module.exports = { add, greet, sign, result };
