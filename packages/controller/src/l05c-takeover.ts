import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import type { MiGPT } from 'mi-gpt'

type Speaker = MiGPT['speaker']
type Turn = {
  id: number
  startedAt: number
  timestamp: number
  modelStarted: boolean
  takenOver: boolean | undefined
  controls: Promise<void>
  stream?: Awaited<ReturnType<NonNullable<Speaker['askAI']>>>['stream']
}

// 与 mi-gpt 4.2.0 的 unWakeUp 使用同一静音文本，不修改设备指令。
const silentText = '\xBF\u029E\u043E \u2229\u043E\u028E \u01DD\u0279\u0250'

export function installL05CTakeover(speaker: Speaker) {
  const initialize = speaker.initMiServices.bind(speaker)
  speaker.initMiServices = async () => {
    await initialize()
    const context = new AsyncLocalStorage<Turn>()
    const pendingControls = new Set<Promise<void>>()
    let generation = 0
    let active: Turn | undefined
    const valid = (turn: Turn) =>
      turn.id === generation &&
      speaker.status === 'running' &&
      speaker.currentQueryMsg?.timestamp === turn.timestamp
    const log = (turn: Turn, event: string, details = {}) => {
      process.stdout.write(
        JSON.stringify({
          scope: '对话接管',
          turnId: turn.id,
          event,
          elapsedMs: Date.now() - turn.startedAt,
          ...details,
        }) + '\n',
      )
    }
    const waitForControls = async () => {
      while (pendingControls.size) await Promise.all([...pendingControls])
    }
    const invalidate = () => {
      generation++
      active?.stream?.cancel()
      active = undefined
    }
    const stop = speaker.stop.bind(speaker)
    speaker.stop = () => {
      invalidate()
      stop()
    }

    const mina = speaker.MiNA!
    const play = mina.play.bind(mina)
    mina.play = async (options) => {
      await waitForControls()
      const turn = context.getStore()
      if (turn) {
        if (!valid(turn) || !turn.takenOver) return false
        log(turn, '正式音频下发')
      }
      return play(options)
    }
    const unWakeUp = speaker.unWakeUp.bind(speaker)
    speaker.unWakeUp = async () => {
      const turn = context.getStore()
      if (turn) {
        await turn.controls
        return
      }
      await waitForControls()
      await unWakeUp()
    }
    const response = speaker.response.bind(speaker)
    speaker.response = async (options) => {
      const turn = context.getStore()
      if (!turn) return response(options)
      // askAIForAnswer 的第一步仅播放思考提示；不改用户保存的提示配置。
      if (!turn.modelStarted) return
      await turn.controls
      await waitForControls()
      if (!valid(turn) || !turn.takenOver) return
      return response({
        ...options,
        playSFX: false,
        hasNewMsg: () => !valid(turn),
      })
    }
    const wakeUp = speaker.wakeUp.bind(speaker)
    speaker.wakeUp = async () => {
      const turn = context.getStore()
      if (turn && (!valid(turn) || !turn.takenOver)) return false
      return wakeUp()
    }
    const askAI = speaker.askAI
    speaker.askAI = async (msg) => {
      const turn = context.getStore()
      if (!turn) return askAI?.call(speaker, msg) ?? {}
      turn.modelStarted = true
      log(turn, '模型请求开始')
      const answer = await askAI?.call(speaker, msg)
      turn.stream = answer?.stream
      if (!valid(turn) || turn.takenOver === false) {
        turn.stream?.cancel()
        return {}
      }
      log(turn, '模型接口返回')
      const text = turn.stream
        ? await turn.stream.getFinalResult()
        : answer?.text
      log(turn, '模型回答完成', { hasAnswer: !!text })
      return valid(turn) ? (answer ?? {}) : {}
    }

    const onMessage = speaker.onMessage.bind(speaker)
    speaker.onMessage = async (msg) => {
      invalidate()
      const commands = speaker.commands
      const index = commands.findIndex((command) => command.match(msg))
      // mi-gpt 4.2.0 的最后一项是 AI 对话，前面包含内建及用户控制命令。
      const isAI = index >= 0 && index === commands.length - 1
      const optimized =
        isAI &&
        mina.account.device.hardware === 'L05C' &&
        speaker.tts === 'custom' &&
        !speaker.streamResponse
      const turn: Turn = {
        id: generation,
        startedAt: Date.now(),
        timestamp: msg.timestamp,
        modelStarted: false,
        takenOver: undefined,
        controls: Promise.resolve(),
      }
      log(turn, '消息匹配', {
        route: isAI
          ? speaker.keepAlive
            ? 'AI会话'
            : 'AI前缀'
          : index < 0
            ? '未命中'
            : '其他命令',
        optimized,
      })
      if (!optimized) return onMessage(msg)
      active = turn
      const control = async (event: string, action: () => Promise<boolean>) => {
        log(turn, event + '开始')
        try {
          const accepted = await action()
          log(turn, event + '返回', { accepted })
          return accepted
        } catch (error) {
          log(turn, event + '失败', {
            errorType: error instanceof Error ? error.name : typeof error,
          })
          return false
        }
      }
      turn.controls = Promise.all([
        control('暂停调用', () => mina.pause()),
        control('静音调用', () =>
          speaker.MiIOT!.doAction(...speaker.ttsCommand, silentText),
        ),
      ]).then(async (accepted) => {
        if (accepted.every(Boolean)) {
          await sleep(100)
          turn.takenOver = true
        } else {
          turn.takenOver = false
          turn.stream?.cancel()
        }
        log(turn, '接管完成', { accepted: turn.takenOver })
      })
      pendingControls.add(turn.controls)
      void turn.controls.then(() => pendingControls.delete(turn.controls))
      await context.run(turn, async () => {
        try {
          await speaker.askAIForAnswer(msg)
          if (valid(turn)) await speaker.exitKeepAliveIfNeeded()
        } catch (error) {
          turn.stream?.cancel()
          log(turn, '对话失败', {
            errorType: error instanceof Error ? error.name : typeof error,
          })
        }
      })
    }
  }
}
