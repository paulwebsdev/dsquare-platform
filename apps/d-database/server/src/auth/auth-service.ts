import { pool } from "../config/database.js";
import { hashPassword, verifyPassword } from "./password.js";
import { createSessionToken, hashSessionToken } from "./session.js";

const SESSION_DURATION_DAYS = 7;

export interface AuthUser {
  id: string;
  email: string;
}

export async function registerUser(
  email: string,
  password: string,
): Promise<AuthUser> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Prevent simultaneous registrations from both claiming legacy projects.
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [72401, 1]);

    const existing = await client.query(
      "SELECT id FROM users WHERE LOWER(email) = LOWER($1)",
      [email],
    );

    if (existing.rowCount) {
      throw new Error("An account with this email already exists.");
    }

    const passwordHash = await hashPassword(password);

    const result = await client.query<AuthUser>(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email`,
      [email.trim().toLowerCase(), passwordHash],
    );

    const user = result.rows[0];

    const count = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM users",
    );

    if (Number(count.rows[0].count) === 1) {
      await client.query(
        "UPDATE projects SET owner_id = $1 WHERE owner_id IS NULL",
        [user.id],
      );
    }

    await client.query("COMMIT");
    return user;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticateUser(
  email: string,
  password: string,
): Promise<AuthUser | null> {
  const result = await pool.query<AuthUser & { password_hash: string }>(
    `SELECT id, email, password_hash
     FROM users
     WHERE LOWER(email) = LOWER($1)`,
    [email.trim()],
  );

  const user = result.rows[0];

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return null;
  }

  return { id: user.id, email: user.email };
}

export async function createUserSession(userId: string): Promise<string> {
  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);

  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 day'))`,
    [tokenHash, userId, SESSION_DURATION_DAYS],
  );

  return token;
}

export async function getUserFromSession(
  token: string,
): Promise<AuthUser | null> {
  const tokenHash = hashSessionToken(token);

  const result = await pool.query<AuthUser>(
    `SELECT users.id, users.email
     FROM user_sessions
     JOIN users ON users.id = user_sessions.user_id
     WHERE user_sessions.token_hash = $1
       AND user_sessions.expires_at > NOW()`,
    [tokenHash],
  );

  return result.rows[0] ?? null;
}

export async function deleteUserSession(token: string): Promise<void> {
  await pool.query(
    "DELETE FROM user_sessions WHERE token_hash = $1",
    [hashSessionToken(token)],
  );
}
