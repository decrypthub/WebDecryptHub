// Minimal JSVMP-style interpreter for benchmark (ground truth: run(bc) => 42)
var bytecode = ["PUSH", "20", "PUSH", "22", "ADD", "HALT"];
var stack = [];
function step(op, arg) {
  switch (op) {
    case "PUSH": stack.push(Number(arg)); break;
    case "ADD": stack.push(stack.pop() + stack.pop()); break;
    case "MUL": stack.push(stack.pop() * stack.pop()); break;
    case "SUB": { var b = stack.pop(); var a = stack.pop(); stack.push(a - b); } break;
    case "DUP": stack.push(stack[stack.length - 1]); break;
    case "HALT": return "HALT";
    case "LOAD": stack.push(arg); break;
    case "STORE": stack.pop(); break;
    case "JMP": break;
    case "JZ": stack.pop(); break;
    case "CALL": break;
    case "RET": break;
    case "NOP": break;
    case "PRINT": break;
    case "EQ": stack.push(stack.pop() === stack.pop() ? 1 : 0); break;
    case "LT": { var d = stack.pop(); var c = stack.pop(); stack.push(c < d ? 1 : 0); } break;
    default: throw new Error("bad op " + op);
  }
}
function run(bc) {
  var pc = 0; stack = [];
  while (pc < bc.length) {
    var op = bc[pc++];
    var arg = undefined;
    if (op === "PUSH" || op === "LOAD") arg = bc[pc++];
    var r = step(op, arg);
    if (r === "HALT") break;
  }
  return stack[stack.length - 1];
}
if (typeof module !== "undefined") module.exports = { run, bytecode, step };
if (typeof self !== "undefined") { self.__mini_vm = { run, bytecode }; }
