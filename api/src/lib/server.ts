import 'dotenv/config'
import express, { type Express } from 'express'
import { WebSocketHTTPServer } from './wss'
import { State } from './state'
import https from 'https'
import http from 'http'
import pem from 'pem'
import { store } from './persistence'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { staticDirectory } from './paths'
import getPort from 'get-port'
import { IncomingMessage, Server, ServerResponse } from 'http'
import { readFileSync } from 'fs'

async function createCertificate(options: pem.CertificateCreationOptions, originalKeys?: any): Promise<pem.CertificateCreationResult> {
  return new Promise((success, fail) => {
    if (originalKeys) {
      pem.checkCertificate(originalKeys?.certificate || '', (error, valid) => {
        if (error || !valid) {
          console.log('Creating updated Self-Signed Certificate')
          pem.createCertificate(options, (error, keys) => {
            if (error) return fail(error)
            success(keys)
          })
        } else {
          console.log('Current Certificate is valid')
          return success(originalKeys)
        }
      })
    } else {
      console.log('Creating new Self-Signed Certificate')
      pem.createCertificate(options, (error, keys) => {
        if (error) return fail(error)
        success(keys)
      })
    }
  })
}

process.on('unhandledRejection', (reason, promise) => {
  console.error(String(reason))
})

export let version = new State('version', '')
export let headless = new State('headless', '')
export let updateChannel = new State('updateChannel', undefined, { persist: true })
export let updateStatus = new State('updateStatus', {})

export let app: Express = express()
app.use(express.json({ limit: '500mb' }))

export let server: Server<typeof IncomingMessage, typeof ServerResponse>
export let wss: WebSocketHTTPServer

async function initSever() {
  const port = Number(process.env.PORT) || (await getPort({ port: 5920 }))
  
  // Check if HTTPS should be enabled (default: true for self-signed cert)
  const useHttps = process.env.DISABLE_HTTPS !== 'true'
  
  if (useHttps) {
    let key: string
    let cert: string
    
    // Check if user provided custom certificate
    if (process.env.CERT_PATH && process.env.KEY_PATH) {
      console.log('Using custom certificate from environment variables')
      try {
        cert = readFileSync(process.env.CERT_PATH, 'utf8')
        key = readFileSync(process.env.KEY_PATH, 'utf8')
      } catch (error) {
        console.error('Error reading certificate files:', error)
        throw new Error('Failed to read custom certificate files. Please check CERT_PATH and KEY_PATH.')
      }
    } else {
      // Generate or retrieve self-signed certificate
      const originalKeys = store['keys']
      const keys = await createCertificate({ days: 365 * 5, selfSigned: true }, originalKeys)
      store['keys'] = keys
      key = keys.serviceKey
      cert = keys.certificate
    }
    
    /** Begin Listening for connections with HTTPS */
    const httpsServer = https.createServer({ key, cert }, app)
    server = httpsServer.listen(port)
    console.log('HTTPS server enabled')
  } else {
    /** Begin Listening for connections with HTTP */
    server = http.createServer(app)
    server.listen(port)
    console.log('HTTP server enabled (HTTPS disabled)')
  }
  
  wss = new WebSocketHTTPServer(server, { path: '/ws' })

  State.subscribe(({ state, action, args }) => {
    wss.send('state', { name: state.name, action, args }, { skip: state.flags.socket })
  })

  wss.msg.on('state', ({ name, action, args }, socket) => {
    State.states[name].flags.socket = socket
    State.states[name].call(action, args)
    delete State.states[name].flags.socket
  })

  wss.on('connection', (socket) => {
    wss.send('initState', State.getStateData(), { to: socket })
  })

  // Enable CORS (https://stackoverflow.com/a/18311469)
  app.use(function (req, res, next) {
    // Website you wish to allow to connect
    res.setHeader('Access-Control-Allow-Origin', '*')

    // Request methods you wish to allow
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE')

    // Request headers you wish to allow
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type')

    // Set to true if you need the website to include cookies in the requests sent
    // to the API (e.g. in case you use sessions)
    res.setHeader('Access-Control-Allow-Credentials', 1)

    // Pass to next layer of middleware
    next()
  })

  app.get('/state', (_, res) => res.json(State.getStateData()))

  // Electron Hook if present
  let parentPort = process['parentPort']

  parentPort?.on('message', (e: any) => {
    console.log('[electron to api]', e)
    if (e.data.event == 'version') {
      version.set(e.data.body)
    } else if (e.data.event == 'headless') {
      headless.set(e.data.body)
    } else if (e.data.event == 'updateChannel') {
      if (e.data.body) updateChannel.set(e.data.body)
    } else if (['update-available', 'download-progress', 'update-downloaded'].includes(e.data.event)) {
      updateStatus.set(e.data)
    }
    // wss?.send(e.data.event, e.data.body)
  })

  updateChannel.subscribe((v) => {
    parentPort?.postMessage({ event: 'setUpdateChannel', body: v })
  })

  app.get('/installUpdate', (req, res) => {
    parentPort?.postMessage({ event: 'installUpdate' })
    res.sendStatus(200)
  })

  app.get('/checkUpdate', (req, res) => {
    parentPort?.postMessage({ event: 'checkUpdate' })
    res.sendStatus(200)
  })
}

export async function createRoutes(callback: (app: Express) => void) {
  await initSever()
  await callback(app)
  finalize()
}

/** Enable user interface and error-handling (Should be after routes!) */
export function finalize() {
  app.use((err, _req, res, _next) => {
    console.error('Error', err)
    wss.send('error', String(err))
    return res.status(500).json(String(err))
  })

  'DEV_UI_URL' in process.env ? enableDevProxy() : app.use(express.static(staticDirectory))
  console.log('Server listening', server.address())
}

export default { app, server, wss, finalize }

/** When in development, proxy UI route instead of serving static files */
function enableDevProxy() {
  let wsProxy = createProxyMiddleware({
    target: process.env.DEV_UI_URL,
    changeOrigin: true,
    ws: true
  })
  server.on('upgrade', wsProxy.upgrade)
  app.use('/', wsProxy)
}
