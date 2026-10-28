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
        let accepted: boolean
        if (
          options?.url &&
          !options.tts &&
          mina.account.device.hardware === 'L05C'
        ) {
          // L05C 协议及默认 item_id 来自 MiService.play_by_music_url：
          // https://github.com/hanxi/MiService/blob/master/miservice/minaservice.py
          const audioId = '1582971365183456177'
          log('选择播放协议', {
            requestId,
            hardware: 'L05C',
            method: 'player_play_music',
          })
          const result = await mina.ubus('mediaplayer', 'player_play_music', {
            startaudioid: audioId,
            music: JSON.stringify({
              payload: {
                audio_type: '',
                audio_items: [
                  {
                    item_id: {
                      audio_id: audioId,
                      cp: {
                        album_id: '-1',
                        episode_index: 0,
                        id: '355454500',
                        name: 'xiaowei',
                      },
                    },
                    stream: { url: options.url },
                  },
                ],
                list_params: {
                  listId: '-1',
                  loadmore_offset: 0,
                  origin: 'xiaowei',
                  type: 'MUSIC',
                },
              },
              play_behavior: 'REPLACE_ALL',
            }),
          })
          accepted = result?.code === 0
          if (accepted) {
            // 与 hass-xiaomi-miot 的 TTS announce 一致，避免单条语音循环。
            const loop = await mina.ubus('mediaplayer', 'player_set_loop', {
              type: 2,
              media: 'common',
            })
            accepted = loop?.code === 0
            log('设置非循环播放', { requestId, accepted })
          }
        } else {
          accepted = await play(options)
        }
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
