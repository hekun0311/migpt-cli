import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { createTTS as createLegacyTTS } from 'mi-gpt-tts'
import type { TTSConfig } from '@migptgui/options'

export function createTTS(config: TTSConfig, provider?: string) {
  const { volcano, ...otherProviders } = config
  if (!volcano || (provider && provider !== 'volcano')) {
    return createLegacyTTS(otherProviders)
  }

  return async (options: {
    text: string
    speaker: string
    stream: Readable
  }) => {
    if (!volcano.apiKey?.trim() || !options.speaker?.trim()) {
      throw new Error(
        '请填写新版火山 API Key 和完整音色 ID，旧版凭证不能用于此接口',
      )
    }
    if (!['seed-icl-2.0', 'seed-tts-2.0'].includes(volcano.resourceId)) {
      throw new Error('请选择火山模型服务')
    }
    if (
      volcano.resourceId === 'seed-icl-2.0' &&
      !['seed-tts-2.0-standard', 'seed-tts-2.0-expressive'].includes(
        volcano.model,
      )
    ) {
      throw new Error('请选择复刻音色的合成效果')
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60_000)
    const cancel = () => controller.abort()
    options.stream.once('close', cancel)
    const chunks: Buffer[] = []
    try {
      const response = await fetch(
        'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': volcano.apiKey.trim(),
            'X-Api-Resource-Id': volcano.resourceId,
            'X-Api-Request-Id': randomUUID(),
          },
          body: JSON.stringify({
            user: { uid: 'migptgui' },
            req_params: {
              text: options.text,
              speaker: options.speaker.trim(),
              ...(volcano.resourceId === 'seed-icl-2.0'
                ? { model: volcano.model }
                : {}),
              audio_params: { format: 'mp3', sample_rate: 24000 },
            },
          }),
        },
      )
      const logId = response.headers.get('x-tt-logid')
      const context = logId ? `（Log ID: ${logId}）` : ''
      if (!response.ok) {
        throw new Error(
          `火山 HTTP ${response.status}: ${await response.text()}${context}`,
        )
      }
      if (!response.body) throw new Error('火山未返回响应内容')

      const body = Readable.fromWeb(
        response.body as Parameters<typeof Readable.fromWeb>[0],
      )
      const lines = createInterface({ input: body, crlfDelay: Infinity })
      let complete = false
      try {
        for await (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line) as {
            code: number
            message?: string
            data?: string
          }
          if (event.code !== 0 && event.code !== 20000000) {
            throw new Error(`火山 ${event.code}: ${event.message}${context}`)
          }
          if (event.data) {
            const chunk = Buffer.from(event.data, 'base64')
            chunks.push(chunk)
            options.stream.push(chunk)
          }
          if (event.code === 20000000) {
            complete = true
            break
          }
        }
      } finally {
        lines.close()
        body.destroy()
      }
      if (!complete) throw new Error(`火山音频流意外中断${context}`)
      if (!chunks.some((chunk) => chunk.length)) {
        throw new Error(`火山未返回音频${context}`)
      }
      options.stream.push(null)
      return Buffer.concat(chunks)
    } finally {
      clearTimeout(timeout)
      options.stream.off('close', cancel)
    }
  }
}
