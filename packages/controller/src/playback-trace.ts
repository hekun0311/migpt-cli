import type { MiGPT } from 'mi-gpt'

export function tracePlayback(speaker: MiGPT['speaker']) {
  let sequence = 0
  const log = (event: string, details: Record<string, unknown> = {}) => {
    process.stdout.write(
      JSON.stringify({ scope: '音箱播放', event, ...details }) + '\n',
    )
  }
  const unWakeUp = speaker.unWakeUp.bind(speaker)
  speaker.unWakeUp = async () => {
    const requestId = ++sequence
    log('开始接管', { requestId })
    await unWakeUp()
    log('接管步骤返回', { requestId })
  }

  const initialize = speaker.initMiServices.bind(speaker)
  speaker.initMiServices = async () => {
    await initialize()
    const mina = speaker.MiNA!
    const play = mina.play.bind(mina)
    mina.play = async (options) => {
      const requestId = ++sequence
      const startedAt = Date.now()
      if (options?.url) {
        const url = new URL(options.url)
        log('下发音频地址', {
          requestId,
          hostname: url.hostname,
          port: url.port,
          protocol: url.protocol,
          textLength: url.searchParams.get('text')?.length,
        })
      } else {
        log('调用原生播放', { requestId })
      }
      try {
        const accepted = await play(options)
        log('播放接口返回', {
          requestId,
          accepted,
          elapsedMs: Date.now() - startedAt,
        })
        return accepted
      } catch (error) {
        log('播放接口异常', {
          requestId,
          elapsedMs: Date.now() - startedAt,
          errorType: error instanceof Error ? error.name : typeof error,
        })
        throw error
      }
    }
  }
}
