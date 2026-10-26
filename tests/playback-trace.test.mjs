import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tracePlayback } from '../packages/controller/dist/playback-trace.js'

async function capture(action) {
  const output = []
  const write = process.stdout.write
  process.stdout.write = (line) => {
    output.push(JSON.parse(line))
    return true
  }
  try {
    await action(output)
  } finally {
    process.stdout.write = write
  }
  return output
}

test('records takeover and rejected URL playback without leaking path or query', async () => {
  const options = {
    url: 'http://example.com:36593/secret-path/tts.mp3?text=private-text&speaker=private-speaker',
  }
  let actual
  const speaker = {
    async unWakeUp() {},
    async initMiServices() {
      this.MiNA = {
        async play(value) {
          actual = value
          return false
        },
      }
    },
  }
  const output = await capture(async () => {
    tracePlayback(speaker)
    await speaker.initMiServices()
    await speaker.unWakeUp()
    assert.equal(await speaker.MiNA.play(options), false)
  })
  assert.equal(actual, options)
  assert.deepEqual(
    output.map((item) => item.event),
    ['开始接管', '接管步骤返回', '下发音频地址', '播放接口返回'],
  )
  assert.equal(output[2].hostname, 'example.com')
  assert.equal(output[3].accepted, false)
  assert.doesNotMatch(
    JSON.stringify(output),
    /secret-path|private-text|private-speaker/,
  )
})

test('preserves successful native playback', async () => {
  const speaker = {
    async unWakeUp() {},
    async initMiServices() {
      this.MiNA = {
        async play() {
          return true
        },
      }
    },
  }
  const output = await capture(async () => {
    tracePlayback(speaker)
    await speaker.initMiServices()
    assert.equal(await speaker.MiNA.play({ tts: 'private-text' }), true)
  })
  assert.equal(output[1].accepted, true)
  assert.doesNotMatch(JSON.stringify(output), /private-text/)
})

test('preserves playback exceptions and logs only error type', async () => {
  const failure = new TypeError('private-error-detail')
  const speaker = {
    async unWakeUp() {},
    async initMiServices() {
      this.MiNA = {
        async play() {
          throw failure
        },
      }
    },
  }
  const output = await capture(async () => {
    tracePlayback(speaker)
    await speaker.initMiServices()
    await assert.rejects(
      speaker.MiNA.play({ url: 'http://example.com/secret' }),
      (error) => error === failure,
    )
  })
  assert.equal(output[1].event, '播放接口异常')
  assert.equal(output[1].errorType, 'TypeError')
  assert.doesNotMatch(JSON.stringify(output), /secret|private-error-detail/)
})
