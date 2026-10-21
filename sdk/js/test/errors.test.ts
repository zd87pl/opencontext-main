import { describe, it, expect } from 'vitest';
import { getErrorMessage, isRevertError } from '../src/errors.js';

describe('getErrorMessage', () => {
  it('uses the message of Error instances', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('passes strings through and stringifies everything else', () => {
    expect(getErrorMessage('plain')).toBe('plain');
    expect(getErrorMessage(42)).toBe('42');
    expect(getErrorMessage(undefined)).toBe('undefined');
  });
});

describe('isRevertError', () => {
  it('ignores non-objects', () => {
    expect(isRevertError(null, 'NoPassport')).toBe(false);
    expect(isRevertError('NoPassport', 'NoPassport')).toBe(false);
  });

  it('matches a decoded custom error by revert name or reason', () => {
    expect(isRevertError({ message: 'execution reverted', revert: { name: 'NoPassport' } }, 'NoPassport')).toBe(true);
    expect(isRevertError({ message: 'execution reverted', reason: 'NoPassport' }, 'NoPassport')).toBe(true);
    expect(isRevertError({ message: 'execution reverted', revert: null }, 'NoPassport')).toBe(false);
  });

  it('falls back to a message substring', () => {
    expect(isRevertError(new Error('reverted: NoPassport()'), 'NoPassport')).toBe(true);
    expect(isRevertError(new Error('out of gas'), 'NoPassport')).toBe(false);
  });
});
