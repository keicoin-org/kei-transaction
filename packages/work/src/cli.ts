#!/usr/bin/env node
import { HttpNode } from '@keicoin/core'
import { startWorkServer } from './server.js'

const nodeUrl = process.env.KEI_NODE_URL ?? 'http://127.0.0.1:7076'
const port = Number(process.env.PORT ?? '7077')
const host = process.env.HOST ?? '127.0.0.1'
const running = await startWorkServer(new HttpNode({ url: nodeUrl, network: 'testnet' }), {
  host,
  port,
  ...(process.env.WORK_SERVER_TOKEN ? { token: process.env.WORK_SERVER_TOKEN } : {}),
})
console.log(`Kei work server listening on ${running.url}`)

const close = () => void running.close().finally(() => process.exit(0))
process.on('SIGINT', close)
process.on('SIGTERM', close)
