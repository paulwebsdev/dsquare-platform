import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const HASH_PREFIX = "dsquare-scrypt$v1";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");

  const derivedKey = (await scrypt(
    password,
    salt,
    KEY_LENGTH,
  )) as Buffer;

  return `${HASH_PREFIX}$${salt}$${derivedKey.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const [brand, version, salt, key] = storedHash.split("$");

  if (
    brand !== "dsquare-scrypt" ||
    version !== "v1" ||
    !salt ||
    !/^[a-f0-9]{32}$/i.test(salt) ||
    !key ||
    !/^[a-f0-9]{128}$/i.test(key)
  ) {
    return false;
  }

  const derivedKey = (await scrypt(
    password,
    salt,
    KEY_LENGTH,
  )) as Buffer;

  return timingSafeEqual(derivedKey, Buffer.from(key, "hex"));
}
