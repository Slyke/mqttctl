import { randomInt } from 'node:crypto';

const bootstrapAlphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const createBootstrapPassword = ({ length = 24 }: { length?: number } = {}) => {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += bootstrapAlphabet[randomInt(bootstrapAlphabet.length)];
  }
  return value;
};

export const normalizeUsername = ({ username }: { username: string }) => username.trim().toLowerCase();

