import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createTTS } from '../packages/server/dist/tts.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const config = {
  volcano: {
    apiKey: 'test-key',
    resourceId: 'seed-icl-2.0',
    model: 'seed-tts-2.0-expressive',
  },
}
const options = () => ({
  text: '前面的区域，以后再来探索吧',
  speaker: 'S_test',
  stream: new Readable({ read() {} }),
})
function responseFrames(events) {
  const bytes = Buffer.from(
    events.map((event) => JSON.stringify(event)).join('\n'),
  )
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7)
          controller.enqueue(bytes.subarray(i, i + 7))
        controller.close()
      },
    }),
  )
}

test('sends V3 API Key, resource, expressive model and decodes split audio frames', async () => {
  const request = options()
  const received = []
  request.stream.on('data', (chunk) => received.push(chunk))
  globalThis.fetch = async (url, init) => {
    assert.equal(
      url,
      'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    )
    assert.equal(init.headers['X-Api-Key'], 'test-key')
    assert.equal(init.headers['X-Api-Resource-Id'], 'seed-icl-2.0')
    const body = JSON.parse(init.body)
    assert.equal(body.req_params.speaker, 'S_test')
    assert.equal(body.req_params.model, 'seed-tts-2.0-expressive')
    assert.deepEqual(body.req_params.audio_params, {
      format: 'mp3',
      sample_rate: 24000,
    })
    return responseFrames([
      {
        code: 0,
        message: '音频',
        data: Buffer.from('first').toString('base64'),
      },
      { code: 0, sentence: { text: 'metadata' } },
      { code: 0, data: Buffer.from('second').toString('base64') },
      { code: 20000000 },
    ])
  }
  const audio = await createTTS(config)(request)
  assert.equal(audio.toString(), 'firstsecond')
  assert.equal(Buffer.concat(received).toString(), 'firstsecond')
})

test('system voices omit the clone-only model field', async () => {
  globalThis.fetch = async (_, init) => {
    assert.equal(init.headers['X-Api-Resource-Id'], 'seed-tts-2.0')
    assert.equal('model' in JSON.parse(init.body).req_params, false)
    return responseFrames([{ code: 0, data: 'YQ==' }, { code: 20000000 }])
  }
  await createTTS({
    volcano: { ...config.volcano, resourceId: 'seed-tts-2.0' },
  })(options())
})

test('HTTP authentication failures retain status and log ID', async () => {
  globalThis.fetch = async () =>
    new Response('permission denied', {
      status: 403,
      headers: { 'x-tt-logid': 'log-test' },
    })
  await assert.rejects(
    createTTS(config)(options()),
    /403: permission denied.*log-test/,
  )
})

test('business errors are surfaced instead of being decoded as audio', async () => {
  globalThis.fetch = async () =>
    responseFrames([{ code: 45000000, message: 'speaker permission denied' }])
  await assert.rejects(
    createTTS(config)(options()),
    /45000000: speaker permission denied/,
  )
})

test('truncated stream and empty successful response are rejected', async () => {
  globalThis.fetch = async () => responseFrames([{ code: 0, data: 'YQ==' }])
  await assert.rejects(createTTS(config)(options()), /意外中断/)
  globalThis.fetch = async () => responseFrames([{ code: 20000000 }])
  await assert.rejects(createTTS(config)(options()), /未返回音频/)
})

test('legacy credentials and missing speaker fail before making a request', async () => {
  globalThis.fetch = async () => {
    assert.fail('must not call upstream')
  }
  await assert.rejects(
    createTTS({ volcano: { appId: 'old', accessToken: 'old' } })(options()),
    /API Key/,
  )
  await assert.rejects(
    createTTS(config)({ ...options(), speaker: '' }),
    /音色 ID/,
  )
})
