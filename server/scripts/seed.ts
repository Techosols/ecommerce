/**
 * Creates the first owner account.
 *
 * Roles and permissions are seeded by migration `0004` — they are reference
 * data and belong in a reviewable, reproducible migration. This script only
 * creates the human who will administer the store, because that needs a
 * password nobody should commit.
 *
 *   SEED_OWNER_EMAIL=you@example.com SEED_OWNER_PASSWORD='…' npm run db:seed
 *
 * Idempotent: running it again on an existing account promotes that account to
 * owner rather than failing or resetting the password.
 */
import { closePool, initPool } from '../src/infrastructure/database/pool.js'
import { usersService } from '../src/features/users/index.js'
import { hashPassword, assertPasswordAcceptable } from '../src/shared/auth/password.js'
import { execute } from '../src/infrastructure/database/query.js'

const email = process.env.SEED_OWNER_EMAIL?.trim().toLowerCase()
const password = process.env.SEED_OWNER_PASSWORD

async function main(): Promise<number> {
  if (!email || !password) {
    console.error(
      '\nSet SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD, e.g.\n' +
        "  SEED_OWNER_EMAIL=you@example.com SEED_OWNER_PASSWORD='a-long-passphrase' npm run db:seed\n",
    )
    return 1
  }

  try {
    assertPasswordAcceptable(password, email)
  } catch (error) {
    // Say exactly what is wrong. A seed that fails silently on a policy detail
    // is a five-minute mystery for whoever is setting the environment up.
    const details = (error as { details?: { message: string }[] }).details ?? []
    console.error('\nThe seed password does not meet the password policy:')
    for (const detail of details) console.error(`  • ${detail.message}`)
    console.error('')
    return 1
  }

  initPool('cli')

  try {
    const existing = await usersService.getByEmail(email)

    if (existing) {
      if (existing.roles.includes('owner')) {
        console.log(`${email} is already an owner. Nothing to do.`)
        return 0
      }
      // Promote rather than replace: never silently reset someone's password.
      await execute(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT $1, id FROM roles WHERE key = 'owner'
         ON CONFLICT DO NOTHING`,
        [existing.id],
      )
      usersService.invalidateAccess(existing.id)
      console.log(`Promoted ${email} to owner.`)
      return 0
    }

    const user = await usersService.create({
      email,
      passwordHash: await hashPassword(password),
      roles: ['owner'],
    })

    // The owner set this password themselves, so the address is trusted.
    await execute(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [user.id])

    console.log(`Created owner ${email} (${user.id}).`)
    return 0
  } catch (error) {
    console.error('\nSeed failed:', error instanceof Error ? error.message : error, '\n')
    return 1
  } finally {
    await closePool()
  }
}

process.exitCode = await main()
