import { Client } from 'ssh2'
import { createWriteStream } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'

export interface SSHConfig {
  host: string
  port?: number
  username: string
  password: string
}

export function sshExec(config: SSHConfig, command: string, timeoutMs = 300000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { conn.end(); reject(new Error(`SSH command timed out after ${timeoutMs}ms`)) }, timeoutMs)

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); return reject(err) }
        stream.on('close', (code: number) => {
          clearTimeout(timer); conn.end()
          resolve({ stdout, stderr, code: code ?? 0 })
        })
        stream.on('data', (data: Buffer) => { stdout += data.toString() })
        stream.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      })
    })
    conn.on('error', (err) => { clearTimeout(timer); reject(err) })
    conn.connect({ host: config.host, port: config.port ?? 22, username: config.username, password: config.password, readyTimeout: 10000 })
  })
}

export function sshExecWithLog(config: SSHConfig, command: string, logFile: string, timeoutMs = 300000): Promise<{ code: number }> {
  return new Promise(async (resolve, reject) => {
    await mkdir(dirname(logFile), { recursive: true })
    const logStream = createWriteStream(logFile, { flags: 'a' })
    const conn = new Client()
    const timer = setTimeout(() => { conn.end(); logStream.end(); reject(new Error('SSH timed out')) }, timeoutMs)

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); logStream.end(); return reject(err) }
        stream.on('close', (code: number) => {
          clearTimeout(timer); conn.end(); logStream.end()
          resolve({ code: code ?? 0 })
        })
        stream.on('data', (data: Buffer) => { logStream.write(data) })
        stream.stderr.on('data', (data: Buffer) => { logStream.write(data) })
      })
    })
    conn.on('error', (err) => { clearTimeout(timer); logStream.end(); reject(err) })
    conn.connect({ host: config.host, port: config.port ?? 22, username: config.username, password: config.password, readyTimeout: 10000 })
  })
}

export function scpDownload(config: SSHConfig, remotePath: string, localPath: string): Promise<void> {
  return new Promise(async (resolve, reject) => {
    await mkdir(dirname(localPath), { recursive: true })
    const conn = new Client()
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err) }
        sftp.fastGet(remotePath, localPath, (err) => {
          conn.end()
          if (err) return reject(err)
          resolve()
        })
      })
    })
    conn.on('error', (err) => reject(err))
    conn.connect({ host: config.host, port: config.port ?? 22, username: config.username, password: config.password, readyTimeout: 10000 })
  })
}
