import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { MiGPT } from 'mi-gpt'
import { installL05CTakeover } from '../packages/controller/dist/l05c-takeover.js'

// 使用真实核心的命令匹配、回答步骤和播放流程，只替换设备与模型 I/O。
const Speaker = MiGPT.create({
  speaker: { userId: 'test-user', password: 'test-password' },
}).speaker.constructor

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function capture(action) {
  const output = []
  const write = process.stdout.write
  const previousURL = process.env.TTS_BASE_URL
  process.stdout.write = (line) => {
    if (typeof line !== 'string' || !line.startsWith('{"scope":"对话接管"'))
      return write.call(process.stdout, line)
    output.push(JSON.parse(line))
    return true
  }
  process.env.TTS_BASE_URL = 'http://example.com/private/tts'
  try {
    await action(output)
  } finally {
    process.stdout.write = write
    if (previousURL === undefined) delete process.env.TTS_BASE_URL
    else process.env.TTS_BASE_URL = previousURL
  }
}

async function fixture({
  pause,
  silent,
  ask,
  hardware = 'L05C',
  tts = 'custom',
  streamResponse = false,
} = {}) {
  const calls = []
  const plays = []
  const speaker = new Speaker({
    tts,
    streamResponse,
    ttsCommand: [5, 3],
    wakeUpCommand: [5, 1],
    callAIKeywords: ['派蒙同学'],
    wakeUpKeywords: ['进入'],
    exitKeywords: ['退出'],
    switchSpeakerKeywords: ['把声音换成'],
    onAIAsking: ['让我先想想'],
    onAIError: ['模型暂时不可用'],
    onEnterAI: [],
    onExitAI: [],
  })
  speaker.logger.disable = true
  speaker.askAI = async (msg) => {
    calls.push('model:' + msg.timestamp)
    return ask ? ask(msg) : { text: '回答' + msg.timestamp }
  }
  speaker.initMiServices = async () => {
    speaker.MiNA = {
      account: { device: { hardware } },
      async pause() {
        calls.push('pause')
        return pause ? pause() : true
      },
      async play(options) {
        calls.push('play')
        plays.push(options)
        return true
      },
    }
    speaker.MiIOT = {
      async doAction(...args) {
        calls.push(['action', ...args])
        return silent ? silent() : true
      },
    }
  }
  speaker.exitKeepAliveIfNeeded = async () => {}
  installL05CTakeover(speaker)
  await speaker.initMiServices()
  return {
    speaker,
    calls,
    plays,
    dispatch(text, timestamp) {
      const msg = { text, timestamp }
      speaker.currentQueryMsg = msg
      return speaker.onMessage(msg)
    },
  }
}

test('slow pause does not block silence or model; one takeover and no thinking audio', async () => {
  await capture(async (output) => {
    const gate = deferred()
    const f = await fixture({ pause: () => gate.promise })
    const task = f.dispatch('派蒙同学，你好', 1)
    await sleep(0)
    assert.deepEqual(
      f.calls.slice(0, 3).map((x) => (Array.isArray(x) ? x[0] : x)),
      ['pause', 'action', 'model:1'],
    )
    await sleep(20)
    assert.equal(f.plays.length, 0)
    gate.resolve(true)
    await task
    assert.equal(f.plays.length, 1)
    assert.equal(new URL(f.plays[0].url).searchParams.get('text'), '回答1')
    assert.equal(f.calls.filter((x) => x === 'pause').length, 1)
    assert.equal(f.calls.filter(Array.isArray).length, 1)
    assert.deepEqual(f.speaker.onAIAsking, ['让我先想想'])
    const action = f.calls.find(Array.isArray)
    assert.deepEqual(action.slice(0, 3), ['action', 5, 3])
    assert.equal(
      action[3],
      '\xBF\u029E\u043E \u2229\u043E\u028E \u01DD\u0279\u0250',
    )
    assert.equal(output.find((x) => x.event === '消息匹配').route, 'AI前缀')
    assert.doesNotMatch(
      JSON.stringify(output),
      /派蒙同学|让我先想想|test-password|private/,
    )
  })
})

test('completed takeover waits for the model without extra device calls', async () => {
  await capture(async () => {
    const gate = deferred()
    const f = await fixture({ ask: () => gate.promise })
    const task = f.dispatch('派蒙同学，你好', 1)
    await sleep(130)
    assert.equal(f.plays.length, 0)
    gate.resolve({ text: '模型回答' })
    await task
    assert.equal(f.plays.length, 1)
    assert.equal(f.calls.filter((x) => x === 'pause').length, 1)
  })
})

test('a new question discards the old answer and waits for old control calls', async () => {
  await capture(async () => {
    const oldPause = deferred()
    const oldModel = deferred()
    let pauses = 0
    const f = await fixture({
      pause: () => (++pauses === 1 ? oldPause.promise : true),
      ask: (msg) =>
        msg.timestamp === 1 ? oldModel.promise : { text: '新回答' },
    })
    const first = f.dispatch('派蒙同学，旧问题', 1)
    const second = f.dispatch('派蒙同学，新问题', 2)
    await sleep(130)
    assert.equal(f.plays.length, 0)
    oldPause.resolve(true)
    oldModel.resolve({ text: '旧回答' })
    await Promise.all([first, second])
    assert.equal(f.plays.length, 1)
    assert.equal(new URL(f.plays[0].url).searchParams.get('text'), '新回答')
  })
})

test('stop during takeover prevents late playback', async () => {
  await capture(async () => {
    const gate = deferred()
    const f = await fixture({ pause: () => gate.promise })
    const task = f.dispatch('派蒙同学，你好', 1)
    f.speaker.stop()
    gate.resolve(true)
    await task
    assert.equal(f.plays.length, 0)
  })
})

test('rejected or throwing control waits for both calls and never plays an answer', async () => {
  for (const pause of [
    async () => false,
    async () => {
      throw new Error('private-secret')
    },
  ]) {
    await capture(async (output) => {
      const f = await fixture({ pause })
      await f.dispatch('派蒙同学，你好', 1)
      assert.equal(f.plays.length, 0)
      assert.equal(f.calls.filter(Array.isArray).length, 1)
      assert.equal(output.find((x) => x.event === '接管完成').accepted, false)
      assert.doesNotMatch(JSON.stringify(output), /private-secret/)
    })
  }
})

test('only startsWith matches; unmatched messages do not pause or call the model', async () => {
  await capture(async (output) => {
    const f = await fixture()
    await f.dispatch('你好派蒙同学', 1)
    assert.deepEqual(f.calls, [])
    assert.equal(output[0].route, '未命中')
  })
})

test('custom commands and session commands keep precedence over the AI branch', async () => {
  await capture(async (output) => {
    const f = await fixture()
    let ran = false
    f.speaker.addCommand({
      match: (msg) => msg.text.startsWith('派蒙同学'),
      run: async () => {
        ran = true
      },
    })
    await f.dispatch('派蒙同学，你好', 1)
    await f.dispatch('进入对话', 2)
    f.speaker.keepAlive = true
    await f.dispatch('退出对话', 3)
    assert.equal(ran, true)
    assert.equal(
      f.calls.filter((x) => typeof x === 'string' && x.startsWith('model:'))
        .length,
      0,
    )
    assert.equal(
      output
        .filter((x) => x.event === '消息匹配')
        .every((x) => x.route === '其他命令'),
      true,
    )
  })
})

test('a pending model stream is canceled on a new message or stop', async () => {
  for (const interrupt of ['message', 'stop']) {
    await capture(async () => {
      const result = deferred()
      let canceled = 0
      const stream = {
        cancel() {
          canceled++
          result.resolve(undefined)
          return true
        },
        getFinalResult: () => result.promise,
      }
      const f = await fixture({ ask: () => ({ stream }) })
      const first = f.dispatch('派蒙同学，旧问题', 1)
      await sleep(0)
      if (interrupt === 'stop') f.speaker.stop()
      else await f.dispatch('无关问题', 2)
      await first
      assert.equal(canceled, 1)
      assert.equal(f.plays.length, 0)
      await sleep(110)
    })
  }
})

test('failed takeover cancels a pending model stream and does not play an error prompt', async () => {
  await capture(async () => {
    const result = deferred()
    const pause = deferred()
    let canceled = 0
    const stream = {
      cancel() {
        canceled++
        result.resolve(undefined)
        return true
      },
      getFinalResult: () => result.promise,
    }
    const f = await fixture({
      pause: () => pause.promise,
      ask: () => ({ stream }),
    })
    const task = f.dispatch('派蒙同学，你好', 1)
    await sleep(0)
    pause.resolve(false)
    await task
    assert.equal(canceled, 1)
    assert.equal(f.plays.length, 0)
  })
})

test('a canceled model result retains the configured custom error prompt after successful takeover', async () => {
  await capture(async () => {
    const stream = {
      cancel() {
        return true
      },
      getFinalResult: async () => undefined,
      getNextResponse: () => ({ noMore: true }),
    }
    const f = await fixture({ ask: () => ({ stream }) })
    await f.dispatch('派蒙同学，你好', 1)
    assert.equal(f.plays.length, 1)
    assert.equal(
      new URL(f.plays[0].url).searchParams.get('text'),
      '模型暂时不可用',
    )
  })
})

test('switch-speaker command keeps priority when its prefix also matches AI', async () => {
  await capture(async (output) => {
    const f = await fixture()
    f.speaker.callAIKeywords.push('把声音换成')
    let switched = false
    f.speaker.switchSpeaker = async () => {
      switched = true
      return true
    }
    await f.dispatch('把声音换成派蒙', 1)
    assert.equal(switched, true)
    assert.equal(
      f.calls.some((x) => typeof x === 'string' && x.startsWith('model:')),
      false,
    )
    assert.equal(output[0].route, '其他命令')
  })
})

test('other models, native TTS and stream mode retain the original message handler', async () => {
  for (const config of [
    { hardware: 'LX06' },
    { tts: 'xiaoai' },
    { streamResponse: true },
  ]) {
    await capture(async (output) => {
      const speaker = new Speaker({ ...config })
      speaker.tts = config.tts ?? 'custom'
      speaker.streamResponse = config.streamResponse ?? false
      let original = 0
      speaker.onMessage = async () => {
        original++
      }
      speaker.initMiServices = async () => {
        speaker.MiNA = {
          account: { device: { hardware: config.hardware ?? 'L05C' } },
          async play() {
            return true
          },
        }
      }
      speaker.callAIKeywords = ['派蒙同学']
      installL05CTakeover(speaker)
      await speaker.initMiServices()
      const msg = { text: '派蒙同学，你好', timestamp: 1 }
      speaker.currentQueryMsg = msg
      await speaker.onMessage(msg)
      assert.equal(original, 1)
      assert.equal(output[0].optimized, false)
    })
  }
})

test('failed pause still waits for the already issued silence call', async () => {
  await capture(async (output) => {
    const gate = deferred()
    const f = await fixture({
      pause: async () => false,
      silent: () => gate.promise,
    })
    const task = f.dispatch('派蒙同学，你好', 1)
    await sleep(0)
    assert.equal(
      output.some((item) => item.event === '接管完成'),
      false,
    )
    gate.resolve(true)
    await task
    assert.equal(
      output.find((item) => item.event === '接管完成').accepted,
      false,
    )
    assert.equal(f.plays.length, 0)
  })
})

test('a model stream is consumed to completion and its answer is played once', async () => {
  await capture(async (output) => {
    const result = deferred()
    const stream = {
      getFinalResult: () => result.promise,
      getNextResponse: () => ({ noMore: true }),
      cancel() {
        assert.fail('successful stream must not be canceled')
      },
    }
    const f = await fixture({ ask: () => ({ stream }) })
    const task = f.dispatch('派蒙同学，你好', 1)
    await sleep(130)
    assert.equal(
      output.some((item) => item.event === '模型接口返回'),
      true,
    )
    assert.equal(
      output.some((item) => item.event === '模型回答完成'),
      false,
    )
    assert.equal(f.plays.length, 0)
    result.resolve('流式接口的完整回答')
    await task
    assert.equal(f.plays.length, 1)
    assert.equal(
      new URL(f.plays[0].url).searchParams.get('text'),
      '流式接口的完整回答',
    )
  })
})
