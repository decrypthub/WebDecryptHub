// 参数校验与建议的单元测试
//
// 覆盖本轮改动：未知参数必须报错（不能静默忽略），且错误里要给出正确参数名。
import test from 'node:test'
import assert from 'node:assert/strict'
import { zod } from '../src/vendor/core-build/src/third_party/index.js'
import {
  strictToolSchema,
  acceptedParameterNames,
  describeUnknownKeys,
} from '../src/vendor/core-build/src/tools/ToolDefinition.js'

const shape = () => ({
  urlFilter: zod.string().optional(),
  pageSize: zod.number().optional(),
  pageIdx: zod.number().optional(),
  methods: zod.array(zod.string()).optional(),
})

test('strictToolSchema 拒绝未知参数，而不是静默剥掉', () => {
  const schema = strictToolSchema(shape())
  const parsed = schema.safeParse({ urlFilter: 'x', url: 'y', limit: 5 })
  assert.equal(parsed.success, false, '未知参数必须让解析失败')
  const codes = parsed.error.issues.map((i) => i.code)
  assert.ok(codes.includes('unrecognized_keys'), '失败原因应是 unrecognized_keys')
})

test('strictToolSchema 不改变合法输入的结果', () => {
  const schema = strictToolSchema(shape())
  const parsed = schema.safeParse({ urlFilter: 'x', pageSize: 3 })
  assert.equal(parsed.success, true)
  assert.deepEqual(parsed.data, { urlFilter: 'x', pageSize: 3 })
  // 空对象也必须通过：所有参数都是可选的
  assert.equal(schema.safeParse({}).success, true)
})

test('acceptedParameterNames 能读出全部参数名', () => {
  const names = acceptedParameterNames(strictToolSchema(shape()))
  assert.deepEqual(names.sort(), ['methods', 'pageIdx', 'pageSize', 'urlFilter'])
})

test('describeUnknownKeys 对近似拼写给出建议', () => {
  const accepted = ['urlFilter', 'pageSize', 'pageIdx', 'methods']
  const cases = [
    ['url', 'urlFilter'],
    ['pageIndex', 'pageIdx'],
    ['method', 'methods'],
    ['pageSizes', 'pageSize'],
  ]
  for (const [wrong, expected] of cases) {
    const msg = describeUnknownKeys({ code: 'unrecognized_keys', keys: [wrong] }, accepted)
    assert.ok(msg, `${wrong} 应产生建议`)
    assert.ok(msg.includes(`did you mean "${expected}"`), `${wrong} 应建议 ${expected}，实际: ${msg}`)
    assert.ok(msg.includes('Accepted parameters:'), '应列出全部合法参数')
  }
})

test('describeUnknownKeys 对完全无关的名字不硬猜', () => {
  const accepted = ['urlFilter', 'pageSize']
  const msg = describeUnknownKeys({ code: 'unrecognized_keys', keys: ['zzzzzzzzzz'] }, accepted)
  assert.ok(msg, '仍应说明这个参数不存在')
  assert.ok(!msg.includes('did you mean'), '不应给出明显错误的建议')
  assert.ok(msg.includes('Accepted parameters:'), '仍应列出合法参数')
})

test('describeUnknownKeys 只处理 unknown-key 类问题', () => {
  assert.equal(describeUnknownKeys({ code: 'invalid_type', path: ['x'] }, ['a']), null)
  assert.equal(describeUnknownKeys(null, ['a']), null)
})

test('一次多个未知参数时逐个给建议', () => {
  const accepted = ['urlFilter', 'pageSize']
  const msg = describeUnknownKeys({ code: 'unrecognized_keys', keys: ['url', 'limit'] }, accepted)
  assert.ok(msg.includes('"url"'), '应提到 url')
  assert.ok(msg.includes('"limit"'), '应提到 limit')
  assert.ok(msg.includes('urlFilter'), 'url 应被建议为 urlFilter')
})
