import {Algorithm, hash, verify} from '@node-rs/argon2';

export function hashPassword(password: string): Promise<string> {
  // The library generates a salt and embeds it with the parameters in the encoded hash.
  return hash(password, {algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1});
}

export function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  return verify(storedHash, password);
}
