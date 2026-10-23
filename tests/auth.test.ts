import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

// Synthetic credentials only; no user profile or network access.
test('saved login requires background evidence, preserves unknown sessions, and cancels logout safely', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luckbag-auth-test-'))
  const file = path.join(dir, 'auth.json')
  const Module = require('node:module'), original = Module._load
  let activeAccount: string | null = null, opened = 0, contexts = 0, saved = 0
  let existing: any = null
  let verdict='connected', probes=0, closedProbes=0
  let release: (() => void) | undefined
  let waitForNavigation: Promise<void> | undefined
  const cookies = [
    { name: 'sessionid', value: 'synthetic-session', expires: -1, domain: '.douyin.com', path: '/' },
    { name: 'uid_tt', value: 'synthetic-user', expires: -1, domain: '.douyin.com', path: '/' }
  ]
  const write = (data: unknown = { cookies, origins: [] }) => fs.writeFileSync(file, JSON.stringify(data))
  Module._load = function (name: string, ...args: any[]) {
    if (name === 'electron') return { app: { getPath: () => dir } }
    if (name === './runtime') return { repository: {
      read: () => ({ activeAccount }), bind: (id: string) => { activeAccount = id },
      unbind: () => { activeAccount = null }
    } }
    if (name === './store') return { store: { get: () => 0 } }
    if (name === './auth-probe') return { probeSession: async (_context: unknown, signal: AbortSignal) => {
      if(verdict==='pending')return new Promise(resolve=>{
        if(signal.aborted)resolve('unknown')
        else signal.addEventListener('abort',()=>resolve('unknown'),{once:true})
      })
      return verdict
    } }
    return original.call(this, name, ...args)
  }
  let AuthService: typeof import('../src/main/auth-service').AuthService
  try { AuthService = require('../src/main/auth-service').AuthService }
  finally { Module._load = original }
  const context = {
    newPage: async () => {
      opened++
      let closed = false
      return {
        goto: async () => { await waitForNavigation },
        isClosed: () => closed, close: async () => { closed = true; release?.() },
        locator: () => ({ first: () => ({ isVisible: async () => true }) })
      }
    },
    cookies: async () => cookies,
    storageState: async (options?: { path: string }) => {
      if(!options)return {cookies,origins:[]}
      const destination=options.path
      saved++; fs.writeFileSync(destination, JSON.stringify({ cookies, origins: [] }))
    }
  }
  const browser: any = {
    setStorageStatePath: () => {}, closeContext: async () => { existing = null },
    getExistingContext: () => existing,
    getContext: async () => { contexts++; return existing = context }
    ,createBackgroundContext: async () => { probes++;return {context,close:async()=>{closedProbes++}} }
  }
  try {
    assert.equal(await new AuthService(browser).restoreSession(), false)
    write()
    const auth = new AuthService(browser)
    assert.deepEqual(await Promise.all([auth.restoreSession(), auth.restoreSession()]), [true, true])
    assert.equal(activeAccount, createHash('sha256').update('douyin-account:synthetic-user').digest('hex'))
    await auth.saveSession()
    assert.equal(contexts, 0)
    assert.equal(opened, 0)
    assert.equal(saved, 1)
    assert.equal(probes, 1)
    assert.equal(closedProbes, 1)
    existing = context
    await auth.saveSession()
    assert.equal(saved, 2)
    verdict='unknown'
    const beforeUnknown=fs.readFileSync(file,'utf8')
    assert.equal(await auth.restoreSession(true),false)
    assert.equal(auth.getStatus().state,'unknown')
    assert.equal(fs.readFileSync(file,'utf8'),beforeUnknown)
    await assert.rejects(auth.validateSession(),/暂时无法验证/)
    verdict='connected'
    assert.equal(await auth.restoreSession(true),true)
    verdict='expired'
    assert.equal(await auth.restoreSession(true),false)
    assert.equal(auth.getStatus().state,'expired')
    assert.equal(fs.existsSync(file),true)
    verdict='connected'
    await auth.logout()
    assert.equal(fs.existsSync(file), false)
    write()
    verdict='pending'
    const backgroundCancelled=new AuthService(browser)
    const checking=backgroundCancelled.restoreSession()
    await new Promise(resolve=>setImmediate(resolve))
    assert.equal(backgroundCancelled.getStatus().state,'checking')
    await backgroundCancelled.logout()
    assert.equal(await checking,false)
    assert.equal(backgroundCancelled.getStatus().state,'signed-out')
    assert.equal(activeAccount,null)
    assert.equal(fs.existsSync(file),false)
    assert.equal(probes,closedProbes)
    assert.equal(await auth.restoreSession(), false)
    assert.equal(activeAccount, null)
    for (const invalid of [
      {}, { cookies: [], origins: [] },
      { cookies: cookies.map(c => ({ ...c, expires: 1 })), origins: [] },
      { cookies: cookies.map(c => ({ ...c, domain: '.example.com' })), origins: [] },
      { cookies: [cookies[0]], origins: [] },
      { cookies: [cookies[1]], origins: [] },
      { cookies: [null], origins: [] }
    ]) {
      write(invalid)
      const rejected = new AuthService(browser)
      assert.equal(await rejected.restoreSession(), false)
      assert.equal(await rejected.restoreSession(), false)
      assert.equal(fs.existsSync(file), true)
    }
    fs.writeFileSync(file, '{broken')
    assert.equal(await new AuthService(browser).restoreSession(), false)
    assert.equal(contexts, 0)
    write()
    const manual = new AuthService(browser)
    assert.equal(await manual.login(), true)
    assert.equal(opened, 1)
    await manual.logout()
    waitForNavigation = new Promise<void>(resolve => { release = resolve })
    const cancelled = new AuthService(browser)
    const loggingIn = cancelled.login()
    await new Promise(resolve => setImmediate(resolve))
    await cancelled.logout()
    assert.equal(await loggingIn, false)
    assert.equal(activeAccount, null)
    assert.equal(fs.existsSync(file), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
