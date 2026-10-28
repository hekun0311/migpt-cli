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
        account: { device: { hardware: 'LX06' } },
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
        account: { device: { hardware: 'LX06' } },
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
        account: { device: { hardware: 'LX06' } },
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

test('L05C URL playback uses the documented music envelope', async () => {
  let request
  const url = 'http://example.com/secret?text=private-text&speaker='
  const speaker = {
    async unWakeUp() {},
    async initMiServices() {
      this.MiNA = {
        account: { device: { hardware: 'L05C' } },
        async play() {
          assert.fail('must not use player_play_url for L05C')
        },
        async ubus(...args) {
          if (args[1] === 'player_play_music') request = args
          else assert.deepEqual(args, ['mediaplayer', 'player_set_loop', { type: 2, media: 'common' }])
          return { code: 0 }
        },
      }
    },
  }
  const output = await capture(async () => {
    tracePlayback(speaker)
    await speaker.initMiServices()
    assert.equal(await speaker.MiNA.play({ url }), true)
  })
  assert.deepEqual(request.slice(0, 2), ['mediaplayer', 'player_play_music'])
  assert.equal(typeof request[2].music, 'string')
  const music = JSON.parse(request[2].music)
  assert.equal(
    request[2].startaudioid,
    music.payload.audio_items[0].item_id.audio_id,
  )
  assert.equal(music.payload.audio_items[0].stream.url, url)
  assert.equal(music.play_behavior, 'REPLACE_ALL')
  assert.equal(music.payload.audio_type, '')
  assert.equal(output[1].method, 'player_play_music')
  assert.equal(output[2].event, '设置非循环播放')
  assert.equal(output[2].accepted, true)
  assert.doesNotMatch(JSON.stringify(output), /secret|private-text/)
})

test('L05C music rejection returns false without trying a different protocol', async () => {
  const speaker = {
    async unWakeUp() {},
    async initMiServices() {
      this.MiNA = {
        account: { device: { hardware: 'L05C' } },
        async play() {
          assert.fail('no protocol fallback')
        },
        async ubus() {
          return { code: 1 }
        },
      }
    },
  }
  await capture(async () => {
    tracePlayback(speaker)
    await speaker.initMiServices()
    assert.equal(
      await speaker.MiNA.play({ url: 'http://example.com/audio.mp3' }),
      false,
    )
  })
})

test('L05C native speech still uses the existing method', async () => {
  const options = { tts: 'test', url: 'http://example.com/audio.mp3' }
  let actual
  const speaker = {
    async unWakeUp() {},
    async initMiServices() {
      this.MiNA = {
        account: { device: { hardware: 'L05C' } },
        async play(value) {
          actual = value
          return true
        },
        async ubus() {
          assert.fail('native speech must not use music')
        },
      }
    },
  }
  await capture(async () => {
    tracePlayback(speaker)
    await speaker.initMiServices()
    assert.equal(await speaker.MiNA.play(options), true)
  })
  assert.equal(actual, options)
})

test('L05C reports failure when disabling repeat is rejected', async () => {
  const methods = []
  const speaker = {
    async unWakeUp() {},
    async initMiServices() {
      this.MiNA = {
        account: { device: { hardware: 'L05C' } },
        async play() { assert.fail('no protocol fallback') },
        async ubus(path, method) {
          methods.push(method)
          return { code: method === 'player_set_loop' ? 1 : 0 }
        },
      }
    },
  }
  const output = await capture(async () => {
    tracePlayback(speaker)
    await speaker.initMiServices()
    assert.equal(await speaker.MiNA.play({ url: 'http://example.com/audio.mp3' }), false)
  })
  assert.deepEqual(methods, ['player_play_music', 'player_set_loop'])
  assert.equal(output.find(item => item.event === '设置非循环播放').accepted, false)
})
