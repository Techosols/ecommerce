-- 0004_identity_and_access.sql
-- Phase 2. Identity, sessions, credential tokens and the RBAC model (§5.2, §6).
-- Forward-only. Never edit a migration that has been applied (§4.4).

-- ─────────────────────────────────────────────────────────────────────────────
-- users — ONE identity table for customers and staff (decision D-7).
--
-- CLAUDE.md §10 requires centralised authentication. Two identity tables would
-- mean two login flows, two token verifiers and two reset flows — the exact
-- duplication being forbidden. Roles decide capability; customer-specific
-- profile data lives in its own table when the customers feature lands.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id                uuid PRIMARY KEY,
  email             citext NOT NULL UNIQUE,
  -- NULL while an account exists without a password: a staff account created by
  -- an owner, or a future SSO identity. Such an account cannot log in with a
  -- password until one is set.
  password_hash     text,
  status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'disabled', 'locked')),
  email_verified_at timestamptz,
  first_name        text,
  last_name         text,
  phone             text,
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX users_created_at_idx ON users (created_at DESC);
CREATE INDEX users_unverified_idx ON users (created_at) WHERE email_verified_at IS NULL;

COMMENT ON TABLE users IS
  'Single identity for customers and staff. Capability comes from roles, not from this row.';
COMMENT ON COLUMN users.status IS
  'active | disabled (an admin turned the account off) | locked (too many failed logins).';

-- ─────────────────────────────────────────────────────────────────────────────
-- RBAC (§6.5). Roles and permissions are reference data, so they are seeded
-- here rather than by a script: every environment gets the same matrix, and a
-- change to it is a reviewable migration.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE roles (
  id          smallserial PRIMARY KEY,
  key         text NOT NULL UNIQUE CHECK (key IN ('owner', 'admin', 'staff', 'customer')),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id          smallserial PRIMARY KEY,
  key         text NOT NULL UNIQUE CHECK (key ~ '^[a-z_]+:[a-z_]+$'),
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN permissions.key IS 'resource:action, e.g. orders:refund.';

CREATE TABLE role_permissions (
  role_id       smallint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id smallint NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    smallint NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX user_roles_role_idx ON user_roles (role_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- sessions — one row per refresh token ever issued (§6.3).
--
-- Rotation inserts a new row in the same family and marks the old one used.
-- A token presented after it was used is theft: the whole family is revoked.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE sessions (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Constant across a rotation chain, so revoking theft revokes the lineage.
  family_id          uuid NOT NULL,
  refresh_token_hash bytea NOT NULL UNIQUE,
  parent_id          uuid REFERENCES sessions(id) ON DELETE SET NULL,
  user_agent         text,
  ip                 inet,
  expires_at         timestamptz NOT NULL,
  -- Set when rotated. A presentation after this timestamp is reuse.
  used_at            timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text CHECK (revoked_reason IN (
                       'logout', 'logout_all', 'rotated', 'reuse_detected',
                       'password_changed', 'password_reset', 'account_disabled',
                       'admin_revoked', 'expired')),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family_idx ON sessions (family_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

COMMENT ON TABLE sessions IS
  'Refresh-token lineage. The hash is stored, never the token itself.';
COMMENT ON COLUMN sessions.used_at IS
  'Set at rotation. Presenting a used token means it leaked — revoke the family.';

-- ─────────────────────────────────────────────────────────────────────────────
-- auth_tokens — single-use, hashed, expiring credential tokens (§6.4).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('email_verify', 'password_reset')),
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One live token per purpose per user: issuing a new one invalidates the old.
CREATE UNIQUE INDEX auth_tokens_live_idx
  ON auth_tokens (user_id, purpose)
  WHERE consumed_at IS NULL;

CREATE INDEX auth_tokens_expires_idx ON auth_tokens (expires_at);

COMMENT ON TABLE auth_tokens IS
  'Email verification and password reset tokens. Only the SHA-256 hash is stored.';

-- ─────────────────────────────────────────────────────────────────────────────
-- login_attempts — throttling and lockout evidence (§6.4).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE login_attempts (
  id         bigserial PRIMARY KEY,
  email      citext,
  ip         inet,
  success    boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX login_attempts_email_idx ON login_attempts (email, created_at DESC);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, created_at DESC);

COMMENT ON TABLE login_attempts IS
  'Append-only record of authentication attempts. Never stores the password tried.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: roles, permissions and the grant matrix (§6.5).
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO roles (key, name, description) VALUES
  ('owner',    'Owner',    'Full control, including staff and role management.'),
  ('admin',    'Admin',    'All operational work plus catalogue, discounts, analytics and settings.'),
  ('staff',    'Staff',    'Day-to-day operations: orders, shipping, inventory, customer lookup.'),
  ('customer', 'Customer', 'Storefront shopper. Granted automatically at registration.');

INSERT INTO permissions (key, description) VALUES
  ('catalog:read',           'View products and categories in the admin.'),
  ('catalog:write',          'Create and edit products and categories.'),
  ('catalog:publish',        'Publish or archive products.'),
  ('inventory:read',         'View stock levels and movements.'),
  ('inventory:adjust',       'Adjust stock.'),
  ('orders:read',            'View orders.'),
  ('orders:write',           'Create and modify orders.'),
  ('orders:cancel',          'Cancel an order.'),
  ('orders:refund',          'Issue a refund.'),
  ('shipping:read',          'View shipments and shipping configuration.'),
  ('shipping:write',         'Create shipments and manage shipping configuration.'),
  ('payments:read',          'View payments.'),
  ('payments:capture',       'Capture or mark a payment as paid.'),
  ('payments:refund',        'Refund a payment.'),
  ('customers:read',         'View customer records.'),
  ('customers:write',        'Edit customer records and account status.'),
  ('customers:impersonate',  'Act as a customer. Defined but granted to nobody.'),
  ('discounts:read',         'View discounts.'),
  ('discounts:write',        'Create and edit discounts.'),
  ('analytics:read',         'View analytics and the dashboard.'),
  ('reports:generate',       'Generate and export reports.'),
  ('settings:read',          'View store settings.'),
  ('settings:write',         'Change store settings.'),
  ('staff:read',             'View staff accounts and the role catalogue.'),
  ('staff:write',            'Create and modify staff accounts.'),
  ('roles:assign',           'Grant or revoke roles.'),
  ('audit:read',             'Read the administrative audit trail.');

-- staff: day-to-day operations.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.key = 'staff'
   AND p.key IN (
     'catalog:read',
     'inventory:read', 'inventory:adjust',
     'orders:read', 'orders:write', 'orders:cancel',
     'shipping:read', 'shipping:write',
     'payments:read',
     'customers:read'
   );

-- admin: everything staff can do, plus catalogue, money, discounts, analytics, settings.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.key = 'admin'
   AND p.key IN (
     'catalog:read', 'catalog:write', 'catalog:publish',
     'inventory:read', 'inventory:adjust',
     'orders:read', 'orders:write', 'orders:cancel', 'orders:refund',
     'shipping:read', 'shipping:write',
     'payments:read', 'payments:capture', 'payments:refund',
     'customers:read', 'customers:write',
     'discounts:read', 'discounts:write',
     'analytics:read', 'reports:generate',
     'settings:read', 'settings:write'
   );

-- owner: everything except customers:impersonate, which is granted to nobody.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.key = 'owner'
   AND p.key <> 'customers:impersonate';

-- customer: no administrative permissions at all. Access to their own data is a
-- resource-level policy (§6.6), not a permission.
