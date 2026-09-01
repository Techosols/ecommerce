import { describe, expect, it } from 'vitest'
import { API_BASE_PATH, env } from '../../src/config/index.js'
import { envSchema } from '../../src/config/env.js'
import { ALLOWED_ORIGINS } from '../../src/shared/middleware/security.js'

describe('configuration', () => {
  it('parses the test environment into typed values', () => {
    expect(env.NODE_ENV).toBe('test')
    expect(typeof env.PORT).toBe('number')
    expect(typeof env.RATE_LIMIT_ENABLED).toBe('boolean')
    expect(typeof env.DATABASE_POOL_MAX).toBe('number')
  })

  it('versions the API in the path', () => {
    expect(API_BASE_PATH).toBe('/api/v1')
  })

  it('allowlists exactly the two known frontend origins — no wildcard', () => {
    expect(ALLOWED_ORIGINS).toHaveLength(2)
    expect(ALLOWED_ORIGINS).toContain(env.CLIENT_ORIGIN)
    expect(ALLOWED_ORIGINS).toContain(env.ADMIN_ORIGIN)
    expect(ALLOWED_ORIGINS).not.toContain('*')
  })

  it('requires a JWT secret long enough to be worth signing with', () => {
    expect(env.JWT_ACCESS_SECRET.length).toBeGreaterThanOrEqual(32)
  })
})

describe('storage configuration (§46)', () => {
  const base = {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/app',
    DATABASE_DIRECT_URL: 'postgres://user:pass@localhost:5432/app',
    JWT_ACCESS_SECRET: 'a-secret-value-that-is-long-enough-1234567890',
    CLIENT_ORIGIN: 'https://shop.example.com',
    ADMIN_ORIGIN: 'https://admin.example.com',
    EMAIL_FROM: 'store@example.com',
  }

  const parse = (overrides: Record<string, string>) => envSchema.safeParse({ ...base, ...overrides })

  it('defaults to local storage, so a developer needs no Supabase project', () => {
    const result = parse({})
    expect(result.success).toBe(true)
    expect(result.data?.STORAGE_PROVIDER).toBe('local')
  })

  it('refuses to select Supabase without both credentials', () => {
    const missing = parse({ STORAGE_PROVIDER: 'supabase' })
    expect(missing.success).toBe(false)
    expect(missing.error?.issues.map((i) => i.path[0])).toEqual(
      expect.arrayContaining(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']),
    )

    const complete = parse({
      STORAGE_PROVIDER: 'supabase',
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'a-service-role-key-long-enough',
    })
    expect(complete.success).toBe(true)
  })

  const production = {
    NODE_ENV: 'production',
    APP_ENV: 'production',
    EMAIL_PROVIDER: 'smtp',
    SMTP_HOST: 'smtp.example.com',
    RUN_WORKERS_IN_PROCESS: 'false',
    DATABASE_SSL: 'true',
    TRUST_PROXY_HOPS: '1',
  }

  it.each(['local', 'memory'])(
    'refuses %s storage in production — a container filesystem does not survive a redeploy',
    (provider) => {
      const result = parse({ ...production, STORAGE_PROVIDER: provider })
      expect(result.success).toBe(false)
      expect(result.error?.issues.some((i) => i.path[0] === 'STORAGE_PROVIDER')).toBe(true)
    },
  )

  it('accepts a fully configured production environment', () => {
    const result = parse({
      ...production,
      STORAGE_PROVIDER: 'supabase',
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'a-service-role-key-long-enough',
    })
    expect(result.success).toBe(true)
  })

  it('refuses the default proxy setting when rate limiting is on', () => {
    // With 0 hops behind a load balancer, `req.ip` is the balancer's address
    // for every request and every per-IP limit becomes one shared bucket —
    // twenty failed logins across all users and the store cannot sign in. It is
    // a one-line misconfiguration with a total-outage blast radius, so
    // production refuses to boot rather than discovering it under load.
    const result = parse({
      ...production,
      STORAGE_PROVIDER: 'supabase',
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'a-service-role-key-long-enough',
      TRUST_PROXY_HOPS: '0',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.some((i) => i.path[0] === 'TRUST_PROXY_HOPS')).toBe(true)
  })

  it('allows 0 hops when rate limiting is off, which is the test and CLI case', () => {
    const result = parse({
      ...production,
      STORAGE_PROVIDER: 'supabase',
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'a-service-role-key-long-enough',
      TRUST_PROXY_HOPS: '0',
      RATE_LIMIT_ENABLED: 'false',
    })
    expect(result.success).toBe(true)
  })

  it('bounds the upload size rather than trusting a client', () => {
    expect(env.MEDIA_MAX_BYTES).toBeGreaterThan(0)
    expect(parse({ MEDIA_MAX_BYTES: '-1' }).success).toBe(false)
    expect(parse({ MEDIA_UPLOAD_URL_TTL_SECONDS: '0' }).success).toBe(false)
  })
})
