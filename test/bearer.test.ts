import { describe, expect, it } from 'vitest';
import { extractBearer } from '../src/auth/authenticate.js';

describe('extractBearer', () => {
  it.each([
    ['standard header', 'Bearer abc', 'abc'],
    ['scheme is case-insensitive', 'bearer abc', 'abc'],
    ['array header uses the first value', ['Bearer x', 'Bearer y'], 'x'],
    ['missing header', undefined, undefined],
    ['non-bearer scheme', 'Basic abc', undefined],
    ['surrounding whitespace trimmed', '  Bearer   spaced  ', 'spaced'],
  ])('%s', (_name, input, expected) => {
    expect(extractBearer(input as string | string[] | undefined)).toBe(expected);
  });
});
