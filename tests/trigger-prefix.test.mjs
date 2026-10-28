import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'

test('custom AI prefixes survive API save, reload and a server restart without default merging', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'migpt-prefix-'))
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  const baseURL = `http://127.0.0.1:${port}`
  let server
  const stop = async () => {
    if (!server || server.exitCode !== null || server.signalCode !== null)
      return
    const exited = once(server, 'exit')
    server.kill()
    await exited
  }
  const start = async () => {
    const entry = new URL('../packages/server/dist/index.js', import.meta.url)
      .href
    server = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { runServer } from ${JSON.stringify(entry)}; runServer({port:${port}});`,
      ],
      {
        env: { ...process.env, HOME: directory, USERPROFILE: directory },
        stdio: 'ignore',
      },
    )
    for (let count = 0; count < 200; count++) {
      assert.equal(
        server.exitCode,
        null,
        'isolated test server must stay running',
      )
      try {
        if ((await fetch(baseURL + '/ping', { method: 'POST' })).status === 204)
          return
      } catch {}
      await sleep(50)
    }
    assert.fail('isolated test server did not become ready')
  }
  try {
    await start()
    const config = {
      config: {
        speaker: { callAIKeywords: ['派蒙同学'], onAIAsking: ['让我先想想'] },
      },
      env: {},
    }
    const saved = await fetch(baseURL + '/api/default', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    assert.equal(saved.status, 200)
    assert.deepEqual(
      (await (await fetch(baseURL + '/api/default')).json()).config,
      config,
    )
    const file = path.join(directory, '.migptgui/default/migptgui.json')
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), config)
    await stop()
    await start()
    assert.deepEqual(
      (await (await fetch(baseURL + '/api/default')).json()).config,
      config,
    )
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), config)
  } finally {
    await stop()
    await rm(directory, { recursive: true, force: true })
  }
})
