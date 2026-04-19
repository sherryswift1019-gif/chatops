import { describe, it, expect } from 'vitest'
import { buildProbeCommand } from '../../agent/tools/env-status/docker-probe.js'

describe('buildProbeCommand', () => {
  describe('bare docker mode (no composeFile)', () => {
    it('runs docker inspect directly against the given name', () => {
      const cmd = buildProbeCommand('my-svc')
      expect(cmd).toContain(`SERVICE_NAME='my-svc'`)
      expect(cmd).toContain('docker inspect "$SERVICE_NAME"')
    })

    it('does not touch docker compose', () => {
      const cmd = buildProbeCommand('my-svc')
      expect(cmd).not.toContain('docker compose')
      expect(cmd).not.toContain('docker-compose')
      expect(cmd).not.toContain('ps -q')
    })

    it('still fetches the image metadata for tag parsing', () => {
      const cmd = buildProbeCommand('my-svc')
      expect(cmd).toContain(`docker inspect --format '{{.Image}}' "$SERVICE_NAME"`)
      expect(cmd).toContain('docker image inspect')
    })
  })

  describe('docker compose mode', () => {
    it('resolves the real container via docker compose ps -q', () => {
      const cmd = buildProbeCommand('proxy', '/opt/paraview/pam-proxy/docker-compose.yml')
      expect(cmd).toContain(`COMPOSE_FILE='/opt/paraview/pam-proxy/docker-compose.yml'`)
      expect(cmd).toContain(`SERVICE_NAME='proxy'`)
      expect(cmd).toContain('ps -q "$SERVICE_NAME"')
    })

    it('detects both docker compose v2 and legacy docker-compose v1', () => {
      const cmd = buildProbeCommand('proxy', '/opt/app/docker-compose.yml')
      expect(cmd).toContain('docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose"')
    })

    it('surfaces distinct error sentinels for missing file vs missing service', () => {
      const cmd = buildProbeCommand('proxy', '/opt/app/docker-compose.yml')
      expect(cmd).toContain('__CHATOPS_ERROR__:compose_file_missing')
      expect(cmd).toContain('__CHATOPS_ERROR__:service_not_found')
    })

    it('falls back to ps -a -q for stopped containers', () => {
      const cmd = buildProbeCommand('proxy', '/opt/app/docker-compose.yml')
      expect(cmd).toContain('ps -a -q "$SERVICE_NAME"')
    })

    it('escapes single quotes in service name and compose file path', () => {
      const cmd = buildProbeCommand(`svc's`, `/opt/it's/docker-compose.yml`)
      expect(cmd).toContain(`SERVICE_NAME='svc'\\''s'`)
      expect(cmd).toContain(`COMPOSE_FILE='/opt/it'\\''s/docker-compose.yml'`)
    })
  })
})
